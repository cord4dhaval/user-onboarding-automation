import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { suppress } from "./suppression.js";
import { notify } from "./notify.js";

/**
 * What SES tells us afterwards, which is the one thing Gmail never did.
 *
 * A Gmail send is confirmed only by silence: the API accepted it, and a bounce arrives
 * later as mail from a postmaster that has to be parsed out of an inbox. SES reports every
 * outcome as an event on the configuration set, so a message is answerable within seconds
 * of landing or failing.
 *
 * Events are attributed by SES's own MessageId, which the send path already stores as
 * `providerMessageId`. No tags, no lookup table — the id on the event is the id on the
 * action.
 */

export interface SesEventSummary {
  type: string;
  applied: boolean;
  detail?: string;
}

interface SesEvent {
  eventType?: string;
  mail?: { messageId?: string; destination?: string[]; timestamp?: string };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }>;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
    complaintFeedbackType?: string;
  };
  delivery?: { recipients?: string[]; smtpResponse?: string };
}

export async function applySesEvent(raw: string): Promise<SesEventSummary> {
  let event: SesEvent;
  try {
    event = JSON.parse(raw) as SesEvent;
  } catch {
    return { type: "unparseable", applied: false, detail: "message body was not JSON" };
  }

  const type = String(event.eventType ?? "unknown");
  const providerMessageId = event.mail?.messageId;
  if (!providerMessageId) return { type, applied: false, detail: "event carried no messageId" };

  const db = await getDb();
  // The action this happened to. Absent for anything sent outside the engine — a console
  // test, a message from another tool on the same account — which is recorded and ignored
  // rather than treated as an error.
  const action = await db.collection(C.actions).findOne({ providerMessageId });
  if (!action) return { type, applied: false, detail: "no action carries this messageId" };

  const orgId = String(action.orgId);
  const productId = String(action.productId);
  const personId = action.personId ? String(action.personId) : undefined;
  const at = event.mail?.timestamp ? new Date(event.mail.timestamp) : new Date();

  if (type === "Bounce") {
    const permanent = event.bounce?.bounceType === "Permanent";
    const recipients = (event.bounce?.bouncedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter(Boolean) as string[];

    // Transient is a full mailbox or a server having a bad hour, and the address is fine.
    // Suppressing on one would throw away a real lead over a temporary condition.
    if (!permanent) {
      await record(orgId, productId, personId, "bounce_soft", at, {
        providerMessageId,
        recipients,
        subType: event.bounce?.bounceSubType,
      });
      return { type, applied: true, detail: "transient bounce recorded, address kept" };
    }

    for (const recipient of recipients) await suppress(orgId, recipient, "hard bounce (SES)");
    await record(orgId, productId, personId, "bounce_received", at, {
      providerMessageId,
      recipients,
      subType: event.bounce?.bounceSubType,
      diagnostic: event.bounce?.bouncedRecipients?.[0]?.diagnosticCode,
    });
    if (personId) await stopEverythingFor(orgId, productId, personId, "hard_bounce");

    await notify({
      orgId,
      productId,
      severity: "good",
      dedupeKey: `engagement:bounced:${personId ?? providerMessageId}`,
      title: `${recipients[0] ?? "An address"} does not exist`,
      body: "The address hard bounced, so they are suppressed and nothing further will be sent.",
      ...(personId ? { href: `/products/${productId}/library/${personId}` } : {}),
    });
    return { type, applied: true, detail: `suppressed ${recipients.length} address(es)` };
  }

  if (type === "Complaint") {
    const recipients = (event.complaint?.complainedRecipients ?? [])
      .map((r) => r.emailAddress)
      .filter(Boolean) as string[];

    // Someone pressed "this is spam". Stronger than an unsubscribe — it is the signal AWS
    // counts, and the one that gets an account suspended — so it suppresses immediately and
    // is never weighed against anything.
    for (const recipient of recipients) await suppress(orgId, recipient, "spam complaint (SES)");
    await record(orgId, productId, personId, "complaint_received", at, {
      providerMessageId,
      recipients,
      feedbackType: event.complaint?.complaintFeedbackType,
    });
    if (personId) await stopEverythingFor(orgId, productId, personId, "complaint");

    await notify({
      orgId,
      productId,
      severity: "action",
      dedupeKey: `engagement:complaint:${personId ?? providerMessageId}`,
      title: `${recipients[0] ?? "Someone"} marked this as spam`,
      body: "They are suppressed. Complaints are what suspend a sending account, so a run of them needs looking at.",
      ...(personId ? { href: `/products/${productId}/library/${personId}` } : {}),
    });
    return { type, applied: true, detail: `suppressed ${recipients.length} address(es)` };
  }

  if (type === "Delivery") {
    // The confirmation the Gmail path has no way to get. Recorded on the action rather than
    // as a status change: "sent" already means it left, and this says it arrived.
    await db.collection(C.actions).updateOne(
      { _id: action._id },
      { $set: { deliveredAt: at, deliveryDetail: event.delivery?.smtpResponse } },
    );
    return { type, applied: true };
  }

  if (type === "Reject") {
    // SES refused it outright — usually the content, usually an attachment. The message
    // never reached anyone, so the touch it spent is worth showing back.
    await db.collection(C.actions).updateOne(
      { _id: action._id },
      { $set: { status: "failed", error: "rejected by SES before sending" } },
    );
    await record(orgId, productId, personId, "send_rejected", at, { providerMessageId });
    return { type, applied: true };
  }

  return { type, applied: false, detail: "event type not handled" };
}

async function record(
  orgId: string,
  productId: string,
  personId: string | undefined,
  type: string,
  ts: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  await db.collection(C.events).insertOne({
    orgId,
    productId,
    ...(personId ? { personId } : {}),
    type,
    ts,
    // Nothing here needs a model's reading: the provider has already said what happened.
    handled: true,
    payload: { ...payload, source: "ses" },
  });
}

/** The same closing-down a hard bounce has always caused, reached from a webhook instead. */
async function stopEverythingFor(
  orgId: string,
  productId: string,
  personId: string,
  outcome: string,
): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db
      .collection(C.people)
      .updateOne({ _id: new ObjectId(personId) }, { $set: { lifecycle: "suppressed", suppressedAt: new Date() } }),
    db.collection(C.actions).updateMany(
      { orgId, productId, personId, status: { $in: ["queued", "awaiting_approval", "held"] } },
      { $set: { status: "skipped", skipReason: outcome } },
    ),
    db.collection(C.goalInstances).updateMany(
      { orgId, productId, personId, status: "active" },
      { $set: { status: "failed", outcome, endedAt: new Date() } },
    ),
  ]);
}
