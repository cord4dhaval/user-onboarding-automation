import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { HOME_TIMEZONE } from "./time.js";

/**
 * Three rules every campaign follows, whatever its settings, because breaking any of them
 * reads to the lead as nobody paying attention:
 *
 *   1. An out-of-office reply is not a reply. The campaign it answered waits until the day
 *      after they are back, and nothing else about them changes.
 *   2. A lead who books a meeting is out of the sequence, whichever page they booked on.
 *   3. A lead who writes back gets an answer, not the next campaign message: whatever that
 *      campaign wrote for them before their reply is dropped, and it plans nothing more
 *      until they are answered.
 *
 * Rules 1 and 3 are campaign by campaign: they act on the campaign whose message the lead
 * answered. Each channel runs as its own campaign, often for another purpose, and a reply
 * to one says nothing about the others. Each lead is also their own: someone at the same
 * company replying changes nothing for anyone else (decided 2026-09-22).
 *
 * Rule 1 is a hold on the campaign until a date (goal_instances.holdUntil, holdReason,
 * holdKind). While it lasts the engine plans nothing for them, and a message that comes due
 * waits for the date instead of being thrown away; the approval a human gave it still
 * stands. When the date passes the campaign carries on by itself.
 *
 * Sales activity is deliberately not here: a meeting the sales team logs in the CRM is
 * context for the next message, never a reason to stop (see crm/sync.ts).
 */

const DAY = 86_400_000;

/** How long an out-of-office reply holds a lead when it names no return date. */
export const ABSENCE_DEFAULT_DAYS = 7;
/** A return date further away than this is misread or a sabbatical; the hold stops here. */
export const ABSENCE_MAX_DAYS = 45;
/** A campaign's deadline is moved past a hold by this much, so the hold does not end it. */
const DEADLINE_MARGIN_DAYS = 5;

/** Site events that mean the lead booked a meeting themselves. */
export const MEETING_EVENTS = new Set(["booked", "meeting_booked", "demo_booked", "call_booked", "meeting_scheduled", "demo_scheduled"]);

// ── the hold ──────────────────────────────────────────────────────────────────

export interface HoldInput {
  orgId: string;
  productId: string;
  goalInstanceIds: string[];
  until: Date;
  reason: string;
  kind: "absence";
  now?: Date;
}

/**
 * Holds these campaigns until `until`. A hold already running past that date is left as it
 * is; a shorter one is extended. Waiting messages move to the new date with the reason
 * beside them, so the lead page and Review say why and until when. Answers to something a
 * person wrote are not moved: those are a conversation.
 */
export async function holdCampaigns(input: HoldInput): Promise<number> {
  const ids = input.goalInstanceIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  if (!ids.length) return 0;
  const db = await getDb();
  const now = input.now ?? new Date();
  const instances = await db
    .collection(C.goalInstances)
    .find({ _id: { $in: ids }, orgId: input.orgId, productId: input.productId, status: "active" })
    .project({ _id: 1, personId: 1, deadline: 1, holdUntil: 1 })
    .toArray();

  let held = 0;
  for (const instance of instances) {
    if (instance.holdUntil && new Date(instance.holdUntil) >= input.until) continue;
    const $set: Document = { holdUntil: input.until, holdReason: input.reason, holdKind: input.kind, holdSetAt: now };
    // The deadline would otherwise end the campaign while it waits, and the waiting message
    // would be skipped as "goal deadline passed" the moment the hold lifts.
    const needed = new Date(input.until.getTime() + DEADLINE_MARGIN_DAYS * DAY);
    if (!(instance.deadline && new Date(instance.deadline) > needed)) $set.deadline = needed;
    await db.collection(C.goalInstances).updateOne({ _id: instance._id }, { $set });
    await db.collection(C.actions).updateMany(
      {
        orgId: input.orgId,
        goalInstanceId: String(instance._id),
        status: { $in: ["queued", "awaiting_approval"] },
        angle: { $ne: "reply" },
        dueAt: { $lt: input.until },
      },
      { $set: { dueAt: input.until, deferReason: input.reason } },
    );
    await db.collection(C.events).insertOne({
      _id: new ObjectId(),
      orgId: input.orgId,
      productId: input.productId,
      personId: String(instance.personId),
      goalInstanceId: String(instance._id),
      source: "engine",
      type: "campaign_held",
      payload: { kind: input.kind, until: input.until, reason: input.reason },
      ts: now,
    });
    held++;
  }
  return held;
}

/** Whether a campaign is held right now, and why. */
export function holdOf(instance: Document | null | undefined, now = new Date()): { until: Date; reason: string; kind: string } | null {
  const until = instance?.holdUntil ? new Date(instance.holdUntil as Date) : null;
  if (!until || Number.isNaN(until.getTime()) || until <= now) return null;
  return { until, reason: String(instance?.holdReason ?? "on hold"), kind: String(instance?.holdKind ?? "") };
}

/** The Mongo condition for campaigns that are not on hold at `now`. */
export function notHeld(now = new Date()): Document {
  return { $or: [{ holdUntil: { $exists: false } }, { holdUntil: null }, { holdUntil: { $lte: now } }] };
}

// ── rule 1: out of office ─────────────────────────────────────────────────────

/** Words that say the writer is away, as opposed to an automatic "we got your mail". */
const ABSENCE =
  /out of (the )?office|\booo\b|on (annual |sick |medical |maternity |paternity |casual )?leave|on (a )?(holiday|vacation|break|sabbatical)|away (from|until|till|on)|travell?ing|limited (access|connectivity)|not in the office|off work|(back|return(ing)?) (on|in|to the office|by)|will be back|public holiday|festival/i;

/** A subject an automatic reply carries. Checked only at the start, where these systems put it. */
const AUTO_SUBJECT = /^\s*(\[?auto(matic)?[-\s]?(reply|response)\]?|autoreply|out of (the )?office|ooo\b|away\b|on leave\b|vacation|holiday notice)/i;

/**
 * Whether a message is an automatic reply, and if so whether it says the person is away.
 * Only the headers mail systems set, or a subject they write, count: a person who types
 * "I am on leave till Monday, but here is my answer" wrote a real reply, and missing that
 * would cost more than holding a campaign a week too long.
 */
export function autoReplyKind(header: (name: string) => string | undefined, subject: string, text: string): "absence" | "auto" | null {
  const submitted = String(header("Auto-Submitted") ?? "").trim().toLowerCase();
  const byHeader =
    (submitted !== "" && submitted !== "no") ||
    Boolean(header("X-Autoreply")) ||
    Boolean(header("X-Autorespond")) ||
    /auto[_-]?reply/i.test(String(header("Precedence") ?? ""));
  if (!byHeader && !AUTO_SUBJECT.test(subject)) return null;
  return ABSENCE.test(`${subject}\n${text}`) ? "absence" : "auto";
}

/**
 * Words only an automatic WhatsApp Business reply writes, whenever it arrives. We wrote to
 * them first, so "thank you for contacting us" is their greeting message, not a person.
 */
const WA_AUTO_ALWAYS =
  /thank(s| you) for (contacting|reaching out|messaging|your message|getting in touch|connecting with|writing to)|this is an? (automated|automatic|auto[- ]?generated) (message|reply|response)|(currently|presently) (unavailable|closed|away|not available)|(outside|out of) (our )?(business|working|office) hours|we are (closed|away) (now|today|for)/i;

/** Words a person might also type, so they count only when they come back within seconds. */
const WA_AUTO_FAST =
  /(how|what) (can|may) (we|i) (help|assist) you|let us know how (we|i) (can|may) (help|assist)|(we|our team|i) (will|shall) (get back|revert|respond|reply|contact you|call you|be in touch)|welcome to /i;

/** A greeting or away message goes out the moment ours lands; a person takes longer to read and type. */
export const WA_AUTO_FAST_MS = 2 * 60_000;

/**
 * Whether a WhatsApp message is the lead's business account answering by itself (the
 * greeting or away message WhatsApp Business sends), and if so whether it says they are
 * away. WhatsApp carries no header for this, so it is read off the words and the timing:
 * "Thank you for contacting SBJ NIRMAL PRODUCTS, let us know how we can help" came back 23
 * seconds after our send, was taken as a reply, and stopped the lead's campaign.
 *
 * `msAfterSend` is how long after our send it came, or undefined when it answers none.
 */
export function whatsAppAutoReplyKind(text: string, msAfterSend: number | undefined): "absence" | "auto" | null {
  const fast = msAfterSend !== undefined && msAfterSend >= 0 && msAfterSend <= WA_AUTO_FAST_MS;
  if (!WA_AUTO_ALWAYS.test(text) && !(fast && WA_AUTO_FAST.test(text))) return null;
  return ABSENCE.test(text) ? "absence" : "auto";
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The calendar date `at` falls on in India, as UTC midnight of that date. */
function homeDay(at: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return new Date(`${parts}T00:00:00Z`);
}

function validDay(year: number, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCMonth() === month ? date : null;
}

/**
 * The last day an away message says the person is away or comes back, as a calendar date
 * (UTC midnight), or null when it names none. Dates are read the Indian way: 5/10 is the
 * fifth of October. A date without a year is this year's, or next year's once this year's
 * has passed. Only dates after today and within ABSENCE_MAX_DAYS count, so a date that is
 * something else ("since 2019", "invoice of 3/4") does not stretch the hold.
 */
export function returnDateFrom(text: string, sent: Date): Date | null {
  const today = homeDay(sent);
  const latest = new Date(today.getTime() + ABSENCE_MAX_DAYS * DAY);
  const found: Date[] = [];
  const withYear = (month: number, day: number, year?: string): Date | null => {
    if (year) {
      const y = Number(year.length === 2 ? `20${year}` : year);
      return validDay(y, month, day);
    }
    const thisYear = validDay(today.getUTCFullYear(), month, day);
    if (thisYear && thisYear.getTime() >= today.getTime() - DAY) return thisYear;
    return validDay(today.getUTCFullYear() + 1, month, day);
  };
  const lower = text.toLowerCase();

  for (const m of lower.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${MONTH_NAMES})\\.?,?(?:\\s+(\\d{4}))?\\b`, "g"))) {
    const d = withYear(MONTHS[m[2]!]!, Number(m[1]), m[3]);
    if (d) found.push(d);
  }
  for (const m of lower.matchAll(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b,?(?:\\s+(\\d{4}))?`, "g"))) {
    const d = withYear(MONTHS[m[1]!]!, Number(m[2]), m[3]);
    if (d) found.push(d);
  }
  for (const m of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = validDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d) found.push(d);
  }
  for (const m of lower.matchAll(/(?<![\d:])(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?![\d:])/g)) {
    const d = withYear(Number(m[2]) - 1, Number(m[1]), m[3]);
    if (d) found.push(d);
  }
  for (const m of lower.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const target = WEEKDAYS.indexOf(m[1]!);
    const ahead = ((target - today.getUTCDay() + 7) % 7) || 7;
    found.push(new Date(today.getTime() + ahead * DAY));
  }
  if (/\btomorrow\b/.test(lower)) found.push(new Date(today.getTime() + DAY));
  if (/\bnext week\b/.test(lower)) found.push(new Date(today.getTime() + 7 * DAY));

  const usable = found.filter((d) => d.getTime() > today.getTime() && d.getTime() <= latest.getTime());
  if (!usable.length) return null;
  return usable.reduce((a, b) => (b > a ? b : a));
}

/**
 * When a held lead's campaign starts again: 9:30 in the morning, India time, the day after
 * the last date their away message names; a week on when it names none.
 */
export function resumeAtFor(text: string, sent: Date): { at: Date; fromMessage: boolean } {
  const last = returnDateFrom(text, sent);
  const day = last ? new Date(last.getTime() + DAY) : new Date(homeDay(sent).getTime() + ABSENCE_DEFAULT_DAYS * DAY);
  // 09:30 IST is 04:00 UTC.
  return { at: new Date(day.getTime() + 4 * 3_600_000), fromMessage: Boolean(last) };
}

/** "6 Oct", in India time, for a reason a person reads. */
export function dayLabel(at: Date): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: HOME_TIMEZONE }).format(at);
}

/** Holds one lead's campaigns until the day after they are back. */
export async function holdForAbsence(input: {
  orgId: string;
  productId: string;
  /** The message of ours the away reply came back on; its campaign is the one held. */
  answeredActionId?: string;
  text: string;
  sent: Date;
  now?: Date;
}): Promise<{ until: Date; fromMessage: boolean; held: number }> {
  const { at, fromMessage } = resumeAtFor(input.text, input.sent);
  const goalInstanceId = await campaignOf(input.orgId, input.answeredActionId);
  const held = goalInstanceId
    ? await holdCampaigns({
        orgId: input.orgId,
        productId: input.productId,
        goalInstanceIds: [goalInstanceId],
        until: at,
        reason: fromMessage ? `out of office; back after ${dayLabel(new Date(at.getTime() - DAY))}` : "out of office; no return date given, so one week",
        kind: "absence",
        now: input.now,
      })
    : 0;
  return { until: at, fromMessage, held };
}

/** The campaign a message of ours belongs to, or null. */
async function campaignOf(orgId: string, actionId: string | undefined): Promise<string | null> {
  if (!actionId || !ObjectId.isValid(actionId)) return null;
  const db = await getDb();
  const action = await db.collection(C.actions).findOne({ _id: new ObjectId(actionId), orgId }, { projection: { goalInstanceId: 1 } });
  const id = action?.goalInstanceId ? String(action.goalInstanceId) : null;
  return id && ObjectId.isValid(id) ? id : null;
}

// ── rule 2: a meeting was booked ──────────────────────────────────────────────

/**
 * Takes a lead who booked a meeting out of the sequence: everything still waiting for them
 * is skipped and no further step is planned. The campaign stays open, so a check such as
 * "signed up" can still close it as a success. Safe to call twice.
 */
export async function stopForMeeting(input: {
  orgId: string;
  productId: string;
  personId: string;
  source: string;
  note?: string;
  now?: Date;
}): Promise<{ skipped: number; stopped: number }> {
  const db = await getDb();
  const now = input.now ?? new Date();
  const skipped = await db.collection(C.actions).updateMany(
    { orgId: input.orgId, productId: input.productId, personId: input.personId, status: { $in: ["queued", "awaiting_approval", "held"] } },
    { $set: { status: "skipped", skipReason: "booked_call" } },
  );
  const stopped = await db.collection(C.goalInstances).updateMany(
    { orgId: input.orgId, productId: input.productId, personId: input.personId, status: "active", handedOverAt: { $exists: false } },
    {
      $set: {
        handedOverAt: now,
        handedOverReason: `booked a meeting (${input.source})`,
        lastReviewNote: input.note ?? `Booked a meeting (${input.source}); sequence stopped, a person takes it from here.`,
      },
    },
  );
  return { skipped: skipped.modifiedCount, stopped: stopped.modifiedCount };
}

// ── rule 3: they wrote back ───────────────────────────────────────────────────

/** The skip reason for rule 3; the person page reads it as "waits for you to answer them". */
export const REPLIED_REASON = "they replied; waiting on a human answer";

/**
 * When a message's words were written: when it was queued, or when it was last rewritten.
 * Approval is not writing. A reviewer approving seventy-five mails at once has not read the
 * reply that came in overnight, and their click does not make the words answer it.
 */
export function writtenAt(action: Document): Date {
  const created = ObjectId.isValid(String(action._id)) ? new ObjectId(String(action._id)).getTimestamp() : new Date(0);
  const rewritten = action.rewrittenAt ? new Date(String(action.rewrittenAt)) : null;
  return rewritten && rewritten > created ? rewritten : created;
}

/**
 * Whether a message was written for a conversation that has since moved on: the lead wrote
 * back, in this campaign, after its words were written. Read off the campaign, not the
 * person: a reply to the email campaign says nothing about a WhatsApp or LinkedIn campaign
 * running beside it for another purpose. An answer to what they wrote is never stale.
 */
export function writtenBeforeReply(action: Document, goalInstance: Document): boolean {
  if (String(action.angle) === "reply") return false;
  const repliedAt = goalInstance.lastReplyAt ? new Date(String(goalInstance.lastReplyAt)) : null;
  return Boolean(repliedAt && repliedAt > writtenAt(action));
}

/**
 * Pauses the one campaign a reply answers: the campaign of the message they wrote back to.
 * Its waiting messages are dropped (unreviewed, in Review, approved, or held for a channel),
 * and the campaign remembers when they replied, which is what keeps it from planning again
 * until they are answered (engine/advance.ts). Only an answer to what they wrote is kept.
 * Their other campaigns run on: each channel is its own campaign, often for another purpose.
 *
 * A reply that answers nothing of ours pauses nothing. The reply event is stamped with the
 * campaign, so marking it answered on the Replies page lets that campaign carry on.
 *
 * Matching unreviewed queued messages alone missed the one waiting in Review. On 21
 * September a lead replied at 23:10 asking for payment details; the "You pay for 9 hours"
 * mail written that morning stayed in Review, was approved with 74 others at 10:26, and went
 * out inside their quotation thread.
 */
export async function pauseForReply(input: {
  orgId: string;
  productId: string;
  /** The message of ours they wrote back to. */
  answeredActionId?: string;
  /** The reply as stored, stamped with the campaign it belongs to. */
  eventId?: ObjectId;
  at: Date;
  reason?: string;
}): Promise<{ goalInstanceId: string | null; skipped: number }> {
  const db = await getDb();
  const goalInstanceId = await campaignOf(input.orgId, input.answeredActionId);
  if (!goalInstanceId) return { goalInstanceId: null, skipped: 0 };

  if (input.eventId) await db.collection(C.events).updateOne({ _id: input.eventId }, { $set: { goalInstanceId } });
  await db
    .collection(C.goalInstances)
    .updateOne(
      { _id: new ObjectId(goalInstanceId), $or: [{ lastReplyAt: { $exists: false } }, { lastReplyAt: { $lt: input.at } }] },
      { $set: { lastReplyAt: input.at } },
    );
  const skipped = await db.collection(C.actions).updateMany(
    {
      orgId: input.orgId,
      productId: input.productId,
      goalInstanceId,
      status: { $in: ["queued", "awaiting_approval", "held"] },
      angle: { $ne: "reply" },
    },
    { $set: { status: "skipped", skipReason: input.reason ?? REPLIED_REASON } },
  );
  return { goalInstanceId, skipped: skipped.modifiedCount };
}
