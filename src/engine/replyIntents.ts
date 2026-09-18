import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { instanceOfLastSend } from "./instances.js";
import { calendarSettingsFrom, slotsFor } from "./booking.js";
import { greetingName } from "./names.js";
import { tokenFor } from "./tracking.js";
import { mergeVarsFor, withUtm } from "./vars.js";

/**
 * Two replies the mails invite in one word, answered by the engine within the minute.
 *
 * The mails say "reply call" and "reply later". A person who does exactly that has made a
 * decision, and the answer to it is not a judgement call: the booking times, or a check-in
 * a month on. Waiting for an hourly routine to write it turns a lead who asked for a call
 * into a lead who waited an hour for one. Anything longer or less plain than these one-word
 * answers stays with the owner and the routine, as before.
 *
 * The answer is queued like any other message, so the campaign's own approval setting
 * decides whether a person reads it first.
 */
export type ReplyIntent = "call" | "later";

const DAY = 86_400_000;

function meaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^sent from my\b/i.test(line) && !/^(thanks|thank you|regards|best|cheers)[\s.,!]*$/i.test(line));
}

const CALL = /^(yes[\s,!.]*)?(please[\s,]*)?(call|call me|call please|a call|let'?s talk|let'?s (do a )?call|book (a|the) call)[\s.!]*$/i;
const LATER = /^(later|maybe later|not now|not right now|next month|in a month|try (me )?later)[\s.!]*$/i;

/** The intent of a reply that is only one of the one-word answers the mails invite, followed at most by a name. */
export function replyIntent(text: string): ReplyIntent | null {
  const lines = meaningfulLines(text);
  if (lines.length === 0 || lines.length > 2) return null;
  if (lines.length === 2 && !/^[A-Za-z][A-Za-z .'-]{0,30}$/.test(lines[1] ?? "")) return null;
  const first = lines[0] ?? "";
  if (CALL.test(first)) return "call";
  if (LATER.test(first)) return "later";
  return null;
}

export function callReplyBody(firstName: string, slots: Array<{ label: string; url: string }>, pickUrl: string): string {
  const lines = [`Hi ${firstName},`, ""];
  if (slots.length > 0) {
    lines.push("Thank you for your reply. Here are the next available times for a 15-minute setup call. Select one to confirm your booking:", "");
    for (const slot of slots) lines.push(`${slot.label}: ${slot.url}`);
    lines.push("", `If none of these times suit you, you can choose another time here: ${pickUrl}`);
  } else {
    lines.push(`Thank you for your reply. You can choose a time for a 15-minute setup call here: ${pickUrl}`);
  }
  lines.push("", "Please have your team size and your current timesheet process to hand.", "", "Best regards,", "The TeamGrid Team");
  return lines.join("\n");
}

export function laterReplyBody(firstName: string, trialLink: string): string {
  return [
    `Hi ${firstName},`,
    "",
    "As requested, we are following up a month after your last message.",
    "",
    `If you would like to see a daily summary of how your team's day went, you can try TeamGrid free for 7 days: ${trialLink}`,
    "",
    "If now is still not the right time, reply \"no\" and we will not contact you again.",
    "",
    "Best regards,",
    "The TeamGrid Team",
  ].join("\n");
}

export interface SimpleReplyInput {
  orgId: string;
  productId: string;
  personId: string;
  /** The provider's id for the reply, so one reply gets one answer however often it is read. */
  messageId: string;
  at: Date;
  eventId?: ObjectId;
}

/**
 * Queues the engine's answer to a one-word reply and stops the sequence. Returns the queued
 * action's id, or null when it cannot answer (no open campaign, no healthy mailbox, no
 * booking calendar for a call) and the reply should go to the routine as usual.
 */
export async function answerSimpleReply(intent: ReplyIntent, input: SimpleReplyInput): Promise<string | null> {
  const db = await getDb();
  const { orgId, productId, personId, at } = input;

  // The campaign whose message they are answering.
  const instance = await instanceOfLastSend({ orgId, productId, personId });
  if (!instance) return null;
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) });
  if (!person) return null;

  // From the address they are already talking to, so the answer lands in the same thread.
  const lastSend = await db
    .collection(C.actions)
    .find({ orgId, productId, personId, status: { $in: ["sent", "dispatched"] }, channelId: { $exists: true } })
    .sort({ sentAt: -1 })
    .limit(1)
    .next();
  const channel =
    (lastSend?.channelId
      ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(lastSend.channelId)), enabled: true, status: "healthy" })
      : null) ?? (await db.collection(C.channels).findOne({ orgId, productId, key: "email", enabled: true, status: "healthy" }));
  if (!channel) return null;

  const firstName = greetingName(String(person.name ?? ""));
  const goalInstanceId = String(instance._id);
  const update: Document = { handedOverAt: at };
  let body: string;
  let dueAt = at;
  let rationale: string;

  if (intent === "call") {
    const asset = await db
      .collection(C.assets)
      .findOne({ orgId, productId, kind: "access", status: "active", "access.calendar.connectionId": { $exists: true } });
    const access = (asset?.access ?? {}) as Record<string, unknown>;
    const settings = calendarSettingsFrom(access);
    if (!asset || !settings || !access.bookingUrl) return null;
    const pickUrl = String(access.bookingUrl)
      .replace("{{person_id}}", personId)
      .replace("{{visit_token}}", tokenFor("e", personId));
    const open = await slotsFor(orgId, settings, 2).catch(() => []);
    const zone = settings.timezone === "Asia/Kolkata" ? " IST" : "";
    body = callReplyBody(
      firstName,
      open.map((slot) => ({ label: `${slot.label}${zone}`, url: `${pickUrl}&slot=${encodeURIComponent(slot.start.toISOString())}` })),
      pickUrl,
    );
    rationale = 'They replied "call"; the booking times went back automatically.';
    update.handedOverReason = "asked for a call";
  } else {
    const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) });
    const vars = mergeVarsFor(person, product);
    body = laterReplyBody(firstName, withUtm(vars.trial_link, String(instance.goalKey ?? "campaign"), "later_check_in"));
    dueAt = new Date(at.getTime() + 30 * DAY);
    rationale = 'They replied "later"; one check-in is scheduled a month on, as the last mail promised.';
    update.handedOverReason = "asked to hear back later";
    // The campaign has to still be open when the check-in is due, or the send guard drops it.
    const needed = new Date(dueAt.getTime() + 5 * DAY);
    if (!(new Date(String(instance.deadline)) > needed)) update.deadline = needed;
  }

  const actionId = new ObjectId();
  try {
    await db.collection(C.actions).insertOne({
      _id: actionId,
      orgId,
      productId,
      goalInstanceId,
      personId,
      channel: String(channel.key),
      channelId: String(channel._id),
      angle: "reply",
      rationale,
      content: {
        bodyMd: "",
        slotText: body,
        personalizationUsed: [],
        claimsMade: [],
        wordCount: body.split(/\s+/).filter(Boolean).length,
      },
      format: "text",
      assetIds: [],
      next: {},
      signals: [],
      idempotencyKey: `${goalInstanceId}:reply:${intent}:${input.messageId}`,
      status: "queued",
      dueAt,
      cost: 0,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("E11000")) return null;
    throw err;
  }

  await db.collection(C.goalInstances).updateOne({ _id: instance._id }, { $set: update });
  if (input.eventId) {
    await db
      .collection(C.events)
      .updateOne({ _id: input.eventId }, { $set: { handled: true, handledAt: new Date(), handledBy: `engine:${intent}` } });
  }
  return String(actionId);
}
