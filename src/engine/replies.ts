import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Every reply, on every channel, in one list, with what came of it.
 *
 * A reply used to exist in four places at once and be finished in none: the bell, the
 * lead's page, the owner's inbox and, once Claude had drafted an answer, Review. Nothing
 * said which replies were still waiting for somebody. This joins the three records a reply
 * leaves (the reply itself, Claude's reading of it, and the answer queued for it) into one
 * row with one state, so the question "who is waiting on us?" has a single answer.
 *
 * Automatic replies are listed apart: an out-of-office message is not someone writing back.
 */

export type ReplyState = "waiting" | "drafted" | "answered" | "closed" | "automatic";

export interface ReplyRow {
  id: string;
  personId: string;
  name: string;
  email: string | null;
  company: string | null;
  channel: string;
  at: Date;
  subject: string | null;
  text: string;
  /** Claude's reading (interested, question, objection, not_now, no, wrong_person, unsubscribe), or the engine's (call, later). */
  intent: string | null;
  answer: { id: string; status: string; text: string; reviewed: boolean; dueAt: Date | null; sentAt: Date | null; why: string | null } | null;
  state: ReplyState;
  /** The state in a few words, and why, for the row. */
  label: string;
  detail: string;
  /** Automatic replies only: until when their campaign waits. */
  holdUntil: Date | null;
}

/** How long a reply may sit unread before it counts as late: the React routine runs hourly. */
const READ_WITHIN_MS = 90 * 60_000;
/** How far back the list reaches. Older replies are on each lead's page. */
const WINDOW_DAYS = 90;
const MAX_ROWS = 1000;

const CLOSED_INTENTS = new Set(["no", "wrong_person", "unsubscribe", "not_now", "later"]);

export const INTENT_LABEL: Record<string, string> = {
  interested: "Interested",
  question: "Question",
  objection: "Objection",
  not_now: "Not now",
  no: "Not interested",
  wrong_person: "Wrong person",
  unsubscribe: "Unsubscribe",
  call: "Asked for a call",
  later: "Asked to hear later",
};

function stateOf(
  row: Omit<ReplyRow, "state" | "label" | "detail">,
  unsubscribed: boolean,
  handled: boolean,
  handledBy: string,
  now: Date,
): Pick<ReplyRow, "state" | "label" | "detail"> {
  const answer = row.answer;
  if (answer && ["sent", "dispatched"].includes(answer.status)) {
    return { state: "answered", label: "Answered", detail: "our answer was sent" };
  }
  if (answer && (answer.status === "queued" || answer.status === "sending") && answer.reviewed) {
    return { state: "answered", label: "Answer approved", detail: "in the send queue" };
  }
  if (answer && (answer.status === "awaiting_approval" || (answer.status === "queued" && !answer.reviewed))) {
    return { state: "drafted", label: "Answer drafted", detail: "Claude wrote an answer; it goes when you approve it" };
  }
  // Answered by a person outside the engine (from Gmail, on a call) and marked done here.
  if (handledBy === "person") {
    return { state: "answered", label: "Marked done", detail: "someone on the team dealt with it" };
  }
  if (unsubscribed || row.intent === "unsubscribe") {
    return { state: "closed", label: "Unsubscribed", detail: "they asked to stop; we will not write again" };
  }
  if (row.intent === "later") {
    return { state: "closed", label: "Check-in booked", detail: "they asked to hear back later; one check-in is queued for 30 days on" };
  }
  if (row.intent && CLOSED_INTENTS.has(row.intent)) {
    return { state: "closed", label: INTENT_LABEL[row.intent] ?? row.intent, detail: "no answer needed" };
  }
  const failed = answer && ["skipped", "failed"].includes(answer.status);
  if (failed) {
    return { state: "waiting", label: "Needs your answer", detail: `the drafted answer did not go: ${answer.why ?? answer.status}` };
  }
  // Read by Claude: marked handled, or tagged with an intent even where the tag was
  // recorded without naming this reply.
  if (handled || row.intent) {
    return { state: "waiting", label: "Needs your answer", detail: "Claude read it and drafted no answer; this one is for a person" };
  }
  const fresh = now.getTime() - row.at.getTime() < READ_WITHIN_MS;
  return fresh
    ? { state: "waiting", label: "Not read yet", detail: "the React routine reads replies every hour and drafts an answer" }
    : { state: "waiting", label: "Needs your answer", detail: "not read by Claude yet; answer it yourself or wait for the next React run" };
}

export async function repliesFor(orgId: string, productId: string, now = new Date()): Promise<ReplyRow[]> {
  const db = await getDb();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const events = await db
    .collection(C.events)
    .find({ orgId, productId, type: { $in: ["reply_received", "auto_reply"] }, ts: { $gte: since } })
    .sort({ ts: -1 })
    .limit(MAX_ROWS)
    .toArray();
  if (!events.length) return [];

  const personIds = [...new Set(events.map((e) => String(e.personId)))];
  const [people, readings, answers, suppressed] = await Promise.all([
    db
      .collection(C.people)
      .find({ _id: { $in: personIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) } })
      .project({ name: 1, primaryEmail: 1, company: 1, companyDomain: 1, lifecycle: 1 })
      .toArray(),
    db
      .collection(C.events)
      .find({ orgId, productId, personId: { $in: personIds }, type: "reply_recorded" })
      .project({ personId: 1, ts: 1, "payload.intent": 1, "payload.replyEventId": 1 })
      .toArray(),
    db
      .collection(C.actions)
      .find({ orgId, productId, personId: { $in: personIds }, angle: "reply" })
      .project({ personId: 1, status: 1, dueAt: 1, sentAt: 1, reviewedAt: 1, skipReason: 1, error: 1, answersEventId: 1, "content.slotText": 1, "content.bodyMd": 1 })
      .toArray(),
    db.collection(C.events).distinct("personId", { orgId, productId, personId: { $in: personIds }, type: "unsubscribed" }),
  ]);
  const personById = new Map(people.map((p) => [String(p._id), p]));
  const unsubscribed = new Set(suppressed.map(String));

  // A person's replies in time order, so each reading and answer is matched to the reply it
  // follows and not to a later one.
  const repliesByPerson = new Map<string, Document[]>();
  for (const e of [...events].filter((e) => e.type === "reply_received").sort((a, b) => +new Date(a.ts) - +new Date(b.ts))) {
    const list = repliesByPerson.get(String(e.personId)) ?? [];
    list.push(e);
    repliesByPerson.set(String(e.personId), list);
  }
  const nextReplyAt = (e: Document): number => {
    const list = repliesByPerson.get(String(e.personId)) ?? [];
    const i = list.findIndex((x) => String(x._id) === String(e._id));
    return i >= 0 && i + 1 < list.length ? +new Date(list[i + 1]!.ts) : Infinity;
  };

  const rows: ReplyRow[] = [];
  for (const e of events) {
    const personId = String(e.personId);
    const person = personById.get(personId);
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const at = new Date(e.ts);
    const base = {
      id: String(e._id),
      personId,
      name: String(person?.name ?? person?.primaryEmail ?? payload.from ?? "Unknown"),
      email: person?.primaryEmail ? String(person.primaryEmail) : null,
      company: person?.company ? String(person.company) : person?.companyDomain ? String(person.companyDomain) : null,
      channel: String(e.channel ?? "email"),
      at,
      subject: payload.subject ? String(payload.subject) : null,
      text: String(payload.text ?? ""),
    };

    if (e.type === "auto_reply") {
      const away = payload.kind === "absence";
      rows.push({
        ...base,
        intent: null,
        answer: null,
        holdUntil: payload.holdUntil ? new Date(payload.holdUntil as Date) : null,
        state: "automatic",
        label: away ? "Out of office" : "Automatic reply",
        detail: away
          ? "not counted as a reply; their campaign waits until they are back"
          : base.channel === "whatsapp"
            ? "sent automatically by their WhatsApp business account; nothing changes"
            : "sent by their mail system; nothing changes",
      });
      continue;
    }

    const until = nextReplyAt(e);
    // Claude's reading: recorded at the reply's own time, or naming it.
    const reading =
      readings.find((r) => String((r.payload as { replyEventId?: string } | undefined)?.replyEventId ?? "") === base.id) ??
      readings.find((r) => String(r.personId) === personId && +new Date(r.ts) === +at) ??
      readings.find((r) => String(r.personId) === personId && +new Date(r.ts) >= +at && +new Date(r.ts) < until);
    const engineIntent = /^engine:(call|later)$/.exec(String(e.handledBy ?? ""))?.[1] ?? null;
    const intent = engineIntent ?? ((reading?.payload as { intent?: string } | undefined)?.intent ?? null);

    // The answer: one that names this reply, else the first one dated from this reply on
    // and before their next.
    const mine = answers.filter((a) => String(a.personId) === personId);
    const answer =
      mine.find((a) => String(a.answersEventId ?? "") === base.id) ??
      mine
        .filter((a) => a.dueAt && +new Date(a.dueAt) >= +at - 60_000 && +new Date(a.dueAt) < until)
        .sort((a, b) => +new Date(a.dueAt) - +new Date(b.dueAt))[0];

    const row = {
      ...base,
      intent,
      holdUntil: null,
      answer: answer
        ? {
            id: String(answer._id),
            status: String(answer.status),
            text: String((answer.content as { slotText?: string; bodyMd?: string } | undefined)?.slotText || (answer.content as { bodyMd?: string } | undefined)?.bodyMd || ""),
            reviewed: Boolean(answer.reviewedAt),
            dueAt: answer.dueAt ? new Date(answer.dueAt) : null,
            sentAt: answer.sentAt ? new Date(answer.sentAt) : null,
            why: answer.skipReason ? String(answer.skipReason) : answer.error ? String(answer.error) : null,
          }
        : null,
    };
    rows.push({ ...row, ...stateOf(row, unsubscribed.has(personId), Boolean(e.handled), String(e.handledBy ?? ""), now) });
  }
  return rows;
}

/**
 * For the side menu: replies that need someone, counted exactly as the page counts them
 * (waiting for an answer, or with a drafted answer to approve). A cheaper count over the
 * events alone disagreed with the page wherever an answer had gone without the reply being
 * marked read, and a badge that disagrees with the page it opens is worse than none.
 */
export async function repliesWaitingCount(orgId: string, productId: string, now = new Date()): Promise<number> {
  return (await repliesFor(orgId, productId, now)).filter((r) => r.state === "waiting" || r.state === "drafted").length;
}
