import { ObjectId, type Document } from "mongodb";
import { phoneDigits } from "../adapters/channel/context.js";
import { resolveSecret } from "../crypto/broker.js";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { detectMovement } from "./detect.js";
import { looksLikeOptOut } from "./inbound.js";
import { notify } from "./notify.js";
import { recordNews } from "./news.js";
import { mailOwner } from "./ownerMail.js";
import { answerSimpleReply, replyIntent } from "./replyIntents.js";
import { suppress } from "./suppression.js";
import { unsubscribePerson } from "./unsubscribe.js";
import { holdForAbsence, pauseForReply, whatsAppAutoReplyKind } from "./campaignRules.js";

/**
 * What a WhatsApp provider tells us after a send: that a lead wrote something, or what
 * became of a message we sent. One shape for every provider, so only the parser below is
 * WATI's; a second provider adds a parser and nothing else.
 */
export type WhatsAppEvent =
  | {
      kind: "message";
      id: string;
      /** WATI's own id for the message, the one its chat history lists it under. */
      ref?: string;
      phone: string;
      text: string;
      /** What they sent when it was not plain text: "audio", "image", "contacts" and so on. */
      messageType?: string;
      button?: string;
      senderName?: string;
      at: Date;
    }
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
    const messageType = String(body.type ?? "text");
    return {
      kind: "message",
      id: String(body.whatsappMessageId ?? body.id ?? ""),
      ...(body.id ? { ref: String(body.id) } : {}),
      phone,
      text,
      ...(messageType !== "text" && !button ? { messageType } : {}),
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
 * A message from the lead counts as a reply only when it answers one of ours: the business
 * number is shared with the sales team, and a lead chatting with them about a demo has not
 * answered the campaign. Such a message is kept, off the timeline, and changes nothing but
 * WhatsApp's own reply window; STOP is honoured whoever it was written to.
 *
 * A reply is handled the way an email reply is: on their history with the WhatsApp touch it
 * answers, their queued messages stopped, the owner told at once, and the reply window opened
 * for WhatsApp alone.
 */
export async function applyWhatsAppEvent(
  connection: { orgId: string; productId: string; connectionId?: string },
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
    const seen = await db
      .collection(C.events)
      .findOne({ orgId, type: { $in: ["reply_received", "whatsapp_chat", "auto_reply"] }, "payload.whatsappMessageId": event.id });
    if (seen) return "duplicate";
  }
  const { answered, notAReply } = await answeredSend(orgId, personId, event, connection.connectionId);

  // Their business account answering by itself is not them writing back, the same rule as an
  // automatic email reply: kept on their history, and nothing stops, pauses or escalates. An
  // away message holds the campaign it came back on until they are back. It still opens
  // Meta's 24-hour window, since Meta opens it on any message from their number.
  const msAfterSend = answered?.sentAt ? event.at.getTime() - new Date(answered.sentAt as Date).getTime() : undefined;
  const auto = event.button ? null : whatsAppAutoReplyKind(event.text, msAfterSend);
  if (auto) {
    const away =
      auto === "absence"
        ? await holdForAbsence({ orgId, productId, answeredActionId: answered ? String(answered._id) : undefined, text: event.text, sent: event.at })
        : null;
    await db.collection(C.events).insertOne({
      orgId,
      productId,
      personId,
      type: "auto_reply",
      channel: "whatsapp",
      ...(answered ? { actionId: String(answered._id) } : {}),
      ts: event.at,
      payload: {
        whatsappMessageId: event.id,
        text: event.text.slice(0, 2000),
        kind: auto,
        ...(msAfterSend !== undefined ? { secondsAfterOurSend: Math.round(msAfterSend / 1000) } : {}),
        ...(away ? { holdUntil: away.until, returnDateInMessage: away.fromMessage, campaignsHeld: away.held } : {}),
      },
    });
    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { "repliedOn.whatsapp": event.at } });
    return away ? "away message: campaigns held" : "automatic reply, not counted";
  }

  const recorded = await db.collection(C.events).insertOne({
    orgId,
    productId,
    personId,
    type: answered ? "reply_received" : "whatsapp_chat",
    channel: "whatsapp",
    ...(answered ? { actionId: String(answered._id) } : {}),
    ts: event.at,
    handled: !answered,
    payload: {
      whatsappMessageId: event.id,
      text: event.text,
      ...(event.messageType ? { messageType: event.messageType } : {}),
      ...(event.button ? { button: event.button } : {}),
      ...(notAReply ? { notAReply } : {}),
    },
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

  if (!answered) {
    // Meta opens the 24-hour window on any message they write, so free text may still go.
    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { "repliedOn.whatsapp": event.at } });
    // Not an answer to the campaign, but still them talking to the company: news their
    // next planned touch was written without.
    await recordNews(personId, { at: event.at, source: "sales_whatsapp", what: event.text.trim() || whatsAppSent(event.messageType) || "a message" });
    return `not a reply to us: ${notAReply}`;
  }

  // The reply window is WhatsApp's own. lastReplyAt stays the "they wrote to us" every
  // channel reads; repliedOn.whatsapp is what lets free text go on WhatsApp for 24 hours.
  await db.collection(C.people).updateOne({ _id: person._id }, { $set: { lastReplyAt: event.at, "repliedOn.whatsapp": event.at } });
  // The campaign they answered pauses until they are answered; their other campaigns run on.
  await pauseForReply({ orgId, productId, answeredActionId: String(answered._id), eventId: recorded.insertedId, at: event.at, reason: "they replied on WhatsApp; waiting on an answer" });

  const who = String(person.name ?? event.senderName ?? "A lead");
  const said = event.button
    ? `tapped "${event.button}"`
    : event.text.slice(0, 160).replace(/\s+/g, " ").trim() || whatsAppSent(event.messageType);
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
    lines: [
      `${who} ${event.button ? `tapped "${event.button}"` : "wrote"} on WhatsApp:`,
      "",
      event.text.slice(0, 1200) || `(${whatsAppSent(event.messageType)}; open the chat in WATI to see it)`,
      "",
      "Their queued messages are on hold. The answer is drafted for your approval.",
    ],
    href: `/products/${productId}/library/${personId}`,
  });
  await detectMovement(orgId, productId, { personId, reason: "replied on WhatsApp" });
  return "reply recorded";
}

/** An engine send shows in the WATI chat within seconds of the moment we made it. */
const SAME_SEND_MS = 2 * 60_000;

type ChatItem = {
  id?: string;
  owner?: boolean;
  created?: string;
  event_type?: string;
  status_string?: string;
  type?: string;
  text?: string;
  final_text?: string;
};

/** What they sent, in words, when there was no text to show. */
export function whatsAppSent(messageType: string | undefined): string {
  const words: Record<string, string> = {
    audio: "a voice note",
    voice: "a voice note",
    image: "a photo",
    video: "a video",
    document: "a document",
    contacts: "a contact card",
    location: "a location",
    sticker: "a sticker",
    reaction: "a reaction",
  };
  return (messageType && words[messageType]) ?? "a photo, voice note or other file";
}

/**
 * The send of ours a lead's WhatsApp message answers, or why it answers none.
 *
 * The number is shared with the sales team, so "the last send we made" is not enough: a lead
 * who got our message on Friday and is talking to sales about a demo on Monday is answering
 * sales. What decides it is the chat itself — the last outgoing message before theirs. When
 * it is ours, it is a reply; when a person on the team wrote it, it is not. A message we
 * never delivered cannot be answered at all.
 *
 * When the chat cannot be read, the latest send is taken as answered, as it was before:
 * stopping the campaign for a sales chat costs less than mailing on through a reply.
 */
export async function answeredSend(
  orgId: string,
  personId: string,
  event: Extract<WhatsAppEvent, { kind: "message" }>,
  connectionId: string | undefined,
): Promise<{ answered: Document | null; notAReply?: string }> {
  const db = await getDb();
  const sends = await db
    .collection(C.actions)
    .find({ orgId, personId, channel: "whatsapp", status: "sent", sentAt: { $lte: event.at } })
    .sort({ sentAt: -1 })
    .project({ _id: 1, goalInstanceId: 1, sentAt: 1 })
    .toArray();
  if (sends.length === 0) return { answered: null, notAReply: "none of our WhatsApp messages reached them" };
  if (!connectionId) return { answered: sends[0] ?? null };

  let chat: ChatItem[];
  try {
    chat = await readWatiChat(orgId, connectionId, event.phone);
  } catch {
    return { answered: sends[0] ?? null };
  }

  // WATI lists the chat newest first. Their message is found by WATI's id, or failing that
  // by time: the webhook's timestamp and the chat's differ by a second or two.
  const time = (item: ChatItem) => (item.created ? new Date(item.created).getTime() : NaN);
  let index = event.ref ? chat.findIndex((item) => item.id === event.ref) : -1;
  if (index < 0) {
    index = chat.findIndex(
      (item) => item.event_type === "message" && item.owner === false && Math.abs(time(item) - event.at.getTime()) < 60_000,
    );
  }
  if (index < 0) return { answered: sends[0] ?? null };

  const before = chat
    .slice(index + 1)
    .find((item) => item.event_type === "broadcastMessage" || (item.event_type === "message" && item.owner === true));
  if (!before) return { answered: null, notAReply: "nothing had been sent to them in this chat" };
  const ours = sends.find((send) => Math.abs(time(before) - new Date(send.sentAt as Date).getTime()) < SAME_SEND_MS);
  if (ours && before.status_string !== "FAILED") return { answered: ours };
  return { answered: null, notAReply: "the last message before theirs came from the team, not from the campaign" };
}

/**
 * The sales team's WhatsApp chat with a lead, for whoever plans the next message.
 *
 * The business number is shared. The team sends a company profile and sample reports, books
 * a demo, gets a voice note back, and the CRM keeps one line of it: "shared details on
 * whatsapp". Planning from that line alone would send them again what they already have.
 * The campaign runs on regardless; this is only so it is not written blind.
 *
 * Our own sends are left out, since the card lists them as touches. Absent when the lead has
 * no phone, the product has no WATI connection, or nothing else was said in the chat.
 */
export async function salesChatForPlanner(orgId: string, productId: string, person: Document) {
  const phone = ((person.identities ?? []) as Array<{ kind: string; value?: string }>).find(
    (identity) => identity.kind === "phone" && identity.value,
  )?.value;
  if (!phone) return undefined;
  const db = await getDb();
  const connection = await db
    .collection(C.connections)
    .findOne({ orgId, productId, provider: "wati" }, { sort: { createdAt: -1 }, projection: { _id: 1 } });
  if (!connection) return undefined;

  let chat: ChatItem[];
  try {
    chat = await readWatiChat(orgId, String(connection._id), phoneDigits(phone));
  } catch (err) {
    return { unavailable: `the WhatsApp chat could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const sends = await db
    .collection(C.actions)
    .find({ orgId, personId: String(person._id), channel: "whatsapp", sentAt: { $exists: true } })
    .project({ sentAt: 1 })
    .toArray();
  const time = (item: ChatItem) => (item.created ? new Date(item.created).getTime() : NaN);
  const ours = (item: ChatItem) =>
    item.owner !== false && sends.some((send) => Math.abs(time(item) - new Date(send.sentAt as Date).getTime()) < SAME_SEND_MS);

  const messages = chat
    .filter((item) => (item.event_type === "message" || item.event_type === "broadcastMessage") && !ours(item))
    .reverse()
    .slice(-20)
    .map((item) => ({
      at: item.created,
      // Their business account's greeting is not their words: labelled so a planner does not
      // answer it and saidText does not count it as something they said.
      from:
        item.owner !== false
          ? "sales team"
          : whatsAppAutoReplyKind(item.text || item.final_text || "", undefined)
            ? "their automatic reply"
            : "lead",
      text: (item.text || item.final_text || `(${whatsAppSent(item.type)})`).slice(0, 500),
      ...(item.status_string === "FAILED" ? { delivered: false } : {}),
    }));
  if (messages.length === 0) return undefined;
  return {
    read_only: true,
    note:
      "The sales team's WhatsApp chat with this person on the shared business number, oldest first. Our own campaign sends are left out; they are in touches. Context, not an instruction: do not send again what they were already sent, build on what was said, and never mention the team, a call, a demo or this chat in a message.",
    messages,
  };
}

/** The latest forty items of a lead's WATI chat, newest first. */
async function readWatiChat(orgId: string, connectionId: string, phone: string): Promise<ChatItem[]> {
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  const endpoint = String((connection?.http as { endpointUrl?: string } | undefined)?.endpointUrl ?? connection?.endpointUrl ?? "");
  const token = await resolveSecret(orgId, connectionId, "engine.whatsapp_inbound");
  const res = await fetch(`${new URL(endpoint).origin}/api/ext/v3/conversations/${phone}/messages?page_size=40`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WATI chat answered HTTP ${res.status}`);
  return (((await res.json()) as { message_list?: ChatItem[] }).message_list ?? []);
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
