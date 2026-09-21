import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { detectMovement } from "./detect.js";
import { looksLikeOptOut } from "./inbound.js";
import { notify } from "./notify.js";
import { mailOwner } from "./ownerMail.js";
import { answerSimpleReply, replyIntent } from "./replyIntents.js";
import { suppress } from "./suppression.js";
import { unsubscribePerson } from "./unsubscribe.js";

/**
 * What a WhatsApp provider tells us after a send: that a lead wrote something, or what
 * became of a message we sent. One shape for every provider, so only the parser below is
 * WATI's; a second provider adds a parser and nothing else.
 */
export type WhatsAppEvent =
  | { kind: "message"; id: string; phone: string; text: string; button?: string; senderName?: string; at: Date }
  | {
      kind: "status";
      ref: string;
      status: "sent" | "delivered" | "read" | "failed";
      code?: string;
      detail?: string;
      at: Date;
      /** Where the status was learned, when it was not the provider's webhook. */
      source?: string;
    };

/**
 * Meta's failure codes in words, for when the provider sends only the number. The report
 * WATI keeps has no detail at all, and "Meta 131049" on a row explains nothing to the person
 * deciding whether to send again.
 */
const META_REASONS: Record<string, string> = {
  "131049":
    "held back to keep this person's marketing messages within Meta's limit. Not a fault in the template or number; a later retry can go through.",
  "131026": "the number cannot receive it (not on WhatsApp, or an app too old for templates).",
  "131047": "more than 24 hours since the person last wrote, so only an approved template can go.",
  "131050": "the person has stopped marketing messages from this business.",
  "130472": "Meta is holding back marketing messages to this number as part of an experiment.",
};

const WATI_STATUS: Record<string, "sent" | "delivered" | "read" | "failed"> = {
  templateMessageSent: "sent",
  templateMessageSent_v2: "sent",
  sessionMessageSent: "sent",
  sessionMessageSent_v2: "sent",
  sentMessageDELIVERED: "delivered",
  sentMessageDELIVERED_v2: "delivered",
  sentMessageREAD: "read",
  sentMessageREAD_v2: "read",
  templateMessageFailed: "failed",
};

/** A WATI webhook body as one of the events above, or null for one we have no use for. */
export function parseWati(body: Record<string, unknown>): WhatsAppEvent | null {
  const type = String(body.eventType ?? "");
  const seconds = Number(body.timestamp);
  const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();

  if (type === "message") {
    // WATI reports our own outgoing messages through the same event, marked as the owner's.
    if (body.owner === true) return null;
    const button =
      (body.buttonReply as { text?: string } | null)?.text ??
      (body.interactiveButtonReply as { title?: string } | null)?.title ??
      (body.listReply as { title?: string } | null)?.title ??
      undefined;
    const text = String(body.text ?? button ?? "").trim();
    const phone = String(body.waId ?? "").replace(/\D/g, "");
    if (!phone) return null;
    return {
      kind: "message",
      id: String(body.whatsappMessageId ?? body.id ?? ""),
      phone,
      text,
      ...(button ? { button: String(button) } : {}),
      ...(body.senderName ? { senderName: String(body.senderName) } : {}),
      at,
    };
  }

  const status = WATI_STATUS[type];
  if (!status || !body.localMessageId) return null;
  return {
    kind: "status",
    ref: String(body.localMessageId),
    status,
    ...(body.failedCode ? { code: String(body.failedCode) } : {}),
    ...(body.failedDetail ? { detail: String(body.failedDetail) } : {}),
    at,
  };
}

const ORDER = { sent: 0, delivered: 1, read: 2, failed: 3 } as const;

/**
 * Applies one event to the lead and the message it concerns.
 *
 * A status goes on the message: delivered and read as it happened, failed as a failed send
 * with Meta's reason, because WATI took the request and only learned later that Meta would
 * not deliver it — the row said "sent" to a person who never received anything.
 *
 * A message from the lead is handled the way an email reply is: on their history with the
 * WhatsApp touch it answers, their queued messages stopped, the owner told at once, STOP
 * honoured without waiting for anyone, and the reply window opened for WhatsApp alone.
 */
export async function applyWhatsAppEvent(
  connection: { orgId: string; productId: string },
  event: WhatsAppEvent,
): Promise<string> {
  const db = await getDb();
  const { orgId, productId } = connection;

  if (event.kind === "status") {
    const action = await db
      .collection(C.actions)
      .findOne({ orgId, productId, channel: "whatsapp", providerMessageId: event.ref });
    if (!action) return "status for a message we do not know";

    const current = (action.delivery as { status?: keyof typeof ORDER } | undefined)?.status ?? "sent";
    if (ORDER[event.status] < ORDER[current]) return "older status, ignored";

    const source = event.source ? { source: event.source } : {};
    if (event.status === "failed") {
      const detail = event.detail ?? (event.code ? META_REASONS[event.code] : undefined);
      await db.collection(C.actions).updateOne(
        { _id: action._id },
        {
          $set: {
            status: "failed",
            error: `WhatsApp did not deliver it${event.code ? ` (Meta ${event.code})` : ""}${detail ? `: ${detail}` : ""}`,
            delivery: { status: "failed", at: event.at, ...(event.code ? { code: event.code } : {}), ...source },
          },
        },
      );
      return "marked failed";
    }
    await db
      .collection(C.actions)
      .updateOne({ _id: action._id }, { $set: { delivery: { status: event.status, at: event.at, ...source }, [`${event.status}At`]: event.at } });
    return `marked ${event.status}`;
  }

  const person = await personByPhone(orgId, productId, event.phone);
  if (!person) return "message from a number that is not a lead";
  const personId = String(person._id);

  if (event.id) {
    const seen = await db.collection(C.events).findOne({ orgId, type: "reply_received", "payload.whatsappMessageId": event.id });
    if (seen) return "duplicate";
  }
  const answered = await db
    .collection(C.actions)
    .findOne({ orgId, personId, channel: "whatsapp", status: "sent", sentAt: { $lte: event.at } }, { sort: { sentAt: -1 }, projection: { _id: 1, goalInstanceId: 1 } });
  const recorded = await db.collection(C.events).insertOne({
    orgId,
    productId,
    personId,
    type: "reply_received",
    channel: "whatsapp",
    ...(answered ? { actionId: String(answered._id) } : {}),
    ts: event.at,
    handled: false,
    payload: { whatsappMessageId: event.id, text: event.text, ...(event.button ? { button: event.button } : {}) },
  });

  // "STOP" on its own is what the template footer asks for, so it counts here even though a
  // bare "stop" in an email is too ambiguous to act on.
  if (/^\s*stop\s*[.!]?\s*$/i.test(event.text) || looksLikeOptOut(event.text)) {
    await unsubscribePerson(personId, "replied STOP on WhatsApp");
    // The number too, so a later import that brings them back cannot message it again.
    for (const identity of (person.identities ?? []) as Array<{ kind: string; value: string }>) {
      if (identity.kind === "phone" && identity.value) await suppress(orgId, identity.value, "replied STOP on WhatsApp");
    }
    return "unsubscribed";
  }

  // The reply window is WhatsApp's own. lastReplyAt stays the "they wrote to us" every
  // channel reads; repliedOn.whatsapp is what lets free text go on WhatsApp for 24 hours.
  await db.collection(C.people).updateOne({ _id: person._id }, { $set: { lastReplyAt: event.at, "repliedOn.whatsapp": event.at } });
  // Every channel stops, not only WhatsApp: someone who wrote back is in a conversation now.
  await db.collection(C.actions).updateMany(
    { orgId, productId, personId, status: "queued", reviewedAt: { $exists: false } },
    { $set: { status: "skipped", skipReason: "they replied on WhatsApp; waiting on an answer" } },
  );

  const who = String(person.name ?? event.senderName ?? "A lead");
  const said = event.button ? `tapped "${event.button}"` : event.text.slice(0, 160).replace(/\s+/g, " ").trim();
  await notify({
    orgId,
    productId,
    severity: "action",
    dedupeKey: `engagement:replied:${personId}`,
    title: `${who} replied on WhatsApp`,
    body: said || undefined,
    href: `/products/${productId}/library/${personId}`,
  });

  // A quick-reply button is an answer in one tap. "Book a setup call" asks for a call as
  // plainly as typing "call" does; the one-word reading covers the rest ("Not right now").
  const intent = event.button && /\bcall\b/i.test(event.button) ? "call" : replyIntent(event.text);
  if (intent === "call") {
    // The booking times go back in the chat they are already in, as free text: they just
    // wrote, so the reply window is open.
    const queued = await answerSimpleReply("call", { orgId, productId, personId, messageId: event.id, at: event.at, eventId: recorded.insertedId });
    if (queued) return "call times queued";
  }
  if (intent === "later") {
    // No check-in is queued on WhatsApp: a month from now the reply window is long shut and
    // free text could not go. Their WhatsApp campaign stops here; any other campaign they
    // are in continues on its own channel.
    if (answered?.goalInstanceId) {
      await db.collection(C.goalInstances).updateOne(
        { _id: new ObjectId(String(answered.goalInstanceId)) },
        { $set: { handedOverAt: event.at, handedOverReason: "said not now on WhatsApp" } },
      );
    }
    await db.collection(C.events).updateOne({ _id: recorded.insertedId }, { $set: { handled: true, handledAt: new Date(), handledBy: "engine:later" } });
    return "not now: WhatsApp stopped for them";
  }

  await mailOwner(orgId, productId, {
    subject: `WhatsApp reply from ${who}`,
    lines: [`${who} ${event.button ? `tapped "${event.button}"` : "wrote"} on WhatsApp:`, "", event.text.slice(0, 1200) || "(no text)", "", "Their queued messages are on hold. The answer is drafted for your approval."],
    href: `/products/${productId}/library/${personId}`,
  });
  await detectMovement(orgId, productId, { personId, reason: "replied on WhatsApp" });
  return "reply recorded";
}

/**
 * The lead behind a WhatsApp number. Numbers are stored the way people typed them —
 * "+91 98765 43210", "9876543210" — so the match is on the last ten digits, with anything
 * but a digit allowed between them.
 */
async function personByPhone(orgId: string, productId: string, phone: string): Promise<Document | null> {
  const tail = phone.slice(-10);
  if (tail.length < 8) return null;
  const pattern = `${tail.split("").join("\\D*")}\\D*$`;
  const db = await getDb();
  return db
    .collection(C.people)
    .findOne(
      { orgId, productId, identities: { $elemMatch: { kind: "phone", value: { $regex: pattern } } } },
      { sort: { createdAt: -1 }, projection: { name: 1, identities: 1 } },
    );
}
