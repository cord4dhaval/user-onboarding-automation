import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { CrmKind } from "../schemas/crm.js";
import type { CrmPersonView } from "./crm/view.js";

/**
 * News about a person from outside our own sends: a note the sales team logged, a meeting,
 * a call that got through, a message they wrote to the sales WhatsApp number.
 *
 * A rolling plan is written against what was known when it was written. A lead who told the
 * sales team after a walk-through that they want the CRM was still sent the time-tracking
 * mail planned an hour earlier, and then a fixed feature email, because nothing here woke
 * the planner. So news is stamped on the person, and the tick drops what the old plan left
 * unsent and asks for a new plan (advance.ts), the way a reply already ends the old one.
 */

/** CRM kinds where somebody did or said something that can change the next message. */
export const NEWS_KINDS: ReadonlySet<CrmKind> = new Set<CrmKind>([
  "note",
  "call",
  "meeting_booked",
  "meeting_held",
  "meeting_canceled",
  "email_in",
  "stage",
  "status",
  "won",
  "lost",
  "reopened",
]);

/** Older history is a backfill arriving, not news: re-planning everyone for last month's notes helps nobody. */
const NEWS_MAX_AGE_MS = 3 * 24 * 3_600_000;

export interface News {
  /** When it happened, as the source says. */
  at: Date;
  source: "crm" | "sales_whatsapp";
  kind?: string;
  what: string;
}

/**
 * Stamps news on a person. newsAt is when it reached us, not when it happened: a note
 * written before the plan but synced after it is still something the plan never saw.
 */
export async function recordNews(personId: string, news: News, now = new Date()): Promise<void> {
  if (!ObjectId.isValid(personId) || now.getTime() - news.at.getTime() > NEWS_MAX_AGE_MS) return;
  const db = await getDb();
  await db
    .collection(C.people)
    .updateOne(
      { _id: new ObjectId(personId) },
      { $set: { newsAt: now, news: { at: news.at, source: news.source, ...(news.kind ? { kind: news.kind } : {}), what: news.what.slice(0, 200) } } },
    );
}

/** When news the plan was written without reached us, or null while the plan is current. */
export function newsSincePlan(person: Document | null | undefined, planWrittenAt: unknown): Date | null {
  if (!person?.newsAt || !planWrittenAt) return null;
  const news = new Date(String(person.newsAt));
  return news > new Date(String(planWrittenAt)) ? news : null;
}

/** The skip reason for a message the news made stale. Starts "plan replaced" so it reads as replaced, not failed. */
export function staleReason(person: Document | null | undefined): string {
  const news = person?.news as { source?: string; what?: string } | undefined;
  const from = news?.source === "sales_whatsapp" ? "their WhatsApp to the sales number" : "the sales CRM";
  return `plan replaced: news from ${from} arrived after it was written${news?.what ? ` ("${news.what.slice(0, 80)}")` : ""}`;
}

type Said = { at?: string | Date; from?: string; text?: string };

/** The words of selling itself and of plain grammar, in every CRM note and chat. They say where a deal stands, not what the person needs. */
const DEAL_WORDS = new Set([
  "demo", "trial", "free", "users", "user", "call", "calls", "meeting", "interested", "purchase", "buy", "offered", "offer",
  "price", "pricing", "completed", "scheduled", "follow", "busy", "details", "shared", "whatsapp", "message", "number",
  "more", "need", "want", "will", "the", "and", "for", "with", "have", "has", "had", "been", "was", "are", "not", "you",
  "your", "our", "they", "them", "him", "her", "his", "their", "this", "that", "from", "about", "also", "can", "all",
  // Arranging a time is not a need either: "a quick demo on Monday, India time".
  "time", "today", "tomorrow", "morning", "evening", "quick", "book", "thanks", "thank", "yes", "there", "let", "india", "ist",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "voice", "note",
  // Nor is the log of trying to reach them: "line busy", "received the call and cut".
  "received", "receiving", "cut", "immediately", "line", "ringing", "reachable", "reached", "picked", "callback",
  "scheduling", "schedule",
]);

/** The words in what someone said that can name a need: three letters or more, the deal talk left out. */
export function heardWords(text: string | undefined): Set<string> {
  // An address or a link says who they are, not what they need.
  const said = String(text ?? "").toLowerCase().replace(/\S+@\S+|https?:\/\/\S+|www\.\S+/g, " ");
  return new Set((said.match(/[a-z]{3,}/g) ?? []).filter((w) => !DEAL_WORDS.has(w)));
}

/** The linked CRM rows that are someone doing or saying something, with when we first held each. */
function crmNews(crm: CrmPersonView | undefined) {
  return (crm?.activity ?? []).filter((a) => !a.review && NEWS_KINDS.has(a.kind));
}

/**
 * What happened after the current plan was written, for the card: the sales team's CRM, the
 * sales WhatsApp chat, and what the person did with our own mail. The plan knew none of it.
 */
export function sinceLastPlan(input: {
  planWrittenAt: unknown;
  crm?: CrmPersonView;
  salesChat?: { messages?: Said[] } | Record<string, unknown>;
  actions: Document[];
  events: Document[];
}) {
  if (!input.planWrittenAt) return undefined;
  const since = new Date(String(input.planWrittenAt));
  const after = (d: unknown) => d !== undefined && d !== null && new Date(String(d)) > since;
  const items: Array<{ at: string; from: string; what: string }> = [];

  for (const a of crmNews(input.crm)) {
    if (!after(a.knownAt ?? a.at)) continue;
    items.push({ at: a.at.toISOString(), from: `sales CRM, ${a.kind}`, what: (a.text ?? a.type).slice(0, 300) });
  }
  for (const m of ((input.salesChat as { messages?: Said[] } | undefined)?.messages ?? [])) {
    if (!after(m.at)) continue;
    items.push({ at: new Date(String(m.at)).toISOString(), from: `sales WhatsApp, ${m.from ?? "unknown"}`, what: String(m.text ?? "").slice(0, 300) });
  }
  for (const a of input.actions) {
    const subject = (a.content as { subject?: string } | undefined)?.subject ?? a.angle;
    if (after(a.firstOpenedAt)) items.push({ at: new Date(String(a.firstOpenedAt)).toISOString(), from: `our ${a.channel ?? "email"}`, what: `opened "${subject}"` });
    if (after(a.firstClickedAt)) items.push({ at: new Date(String(a.firstClickedAt)).toISOString(), from: `our ${a.channel ?? "email"}`, what: `clicked in "${subject}"` });
  }
  for (const e of input.events) {
    if (e.type !== "reply_received" || !after(e.ts)) continue;
    const text = (e.payload as { text?: string } | undefined)?.text;
    items.push({ at: new Date(String(e.ts)).toISOString(), from: `their reply, ${e.channel ?? "email"}`, what: String(text ?? "").slice(0, 300) || "(no text)" });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  return {
    plan_written_at: since.toISOString(),
    note: items.length
      ? "Everything that happened after the current plan was written: the plan knew none of it. Read this before anything else. A need, a question or an offer here (what they said they want most, what they were offered) decides the next touch before the idea bank's rank does, and a new plan must not contradict it. Build on it; never mention the team, a call, a demo, a chat or the CRM in a message."
      : "Nothing new since the current plan was written.",
    items,
  };
}

/**
 * What this person and the sales team said about what they want, for ranking ideas and
 * picking a fallback email: CRM notes and meeting summaries, and the person's own WhatsApp
 * messages. Newest last, capped, so a long history does not drown the latest need.
 */
export function saidText(crm: CrmPersonView | undefined, salesChat: { messages?: Said[] } | Record<string, unknown> | undefined): string {
  const notes = crmNews(crm).map((a) => [a.text, (a.meta as { actionItems?: unknown[] } | undefined)?.actionItems?.join(" ")].filter(Boolean).join(" "));
  const theirs = ((salesChat as { messages?: Said[] } | undefined)?.messages ?? []).filter((m) => m.from === "lead").map((m) => String(m.text ?? ""));
  return [...notes, ...theirs].filter(Boolean).slice(-15).join(" ").slice(-2000);
}
