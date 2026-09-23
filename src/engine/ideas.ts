import type { Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ROLLING_MAX_STEPS } from "./rolling.js";
import { ideaPerformance, type IdeaRow } from "./outcomes.js";
import { heardWords } from "./news.js";

/**
 * The product's idea bank, used on every plan.
 *
 * Dhaval, 2026-09-17: the 88 ideas are the heart of the content, but a planner shown ten at
 * random, and then a handful of hook examples, wrote the same eight scenes to every lead. So
 * each idea carries the hook that lands it, the verified capability that makes it true and
 * the sample card that can show it. Every plan names the ideas it uses, and the lead card
 * ranks the whole bank for the person in front of it, with how often each idea was used on
 * other leads this week so the campaign spreads rather than repeats.
 */

export interface Idea {
  n: number;
  title: string;
  detail?: string;
  hook: string;
  proof: string;
  plan?: string;
  card?: "summary" | "apps" | "day" | "none";
  segments?: string[];
  keywords?: string[];
  usable?: boolean;
  note?: string;
  /** Why the idea lands, in one sentence: what Claude learns from it. */
  pattern?: string;
  /** Other shapes the same pattern can take ("this can also be this or that"). */
  also?: string[];
  /** Absent on the approved bank; "claude" on an idea a planner invented. */
  source?: "claude";
  /** Invented ideas only: trial (a few leads), active (used like the bank), retired. */
  status?: "trial" | "active" | "retired";
}

/**
 * The learning loop: results in the ranking, and ideas Claude invents. On everywhere by
 * default (Dhaval, 2026-09-18, after first asking for development only). IDEAS_LOOP=off is
 * the kill switch: the bank goes back to fit alone and invented ideas are ignored.
 */
export function ideasLoopOn(): boolean {
  return process.env.IDEAS_LOOP !== "off";
}

/** An idea a planner wrote because nothing in the bank fitted, with why and where it came from. */
export interface InventedIdea extends Idea {
  source: "claude";
  status: "trial" | "active" | "retired";
  reason: string;
  fromRefs?: number[];
  bornFor?: { goalInstanceId: string; goalKey: string };
  createdAt: Date;
  statusReason?: string;
  statusAt?: Date;
}

/** Invented ideas are numbered from here, clear of the bank's 1 to 88. */
export const INVENTED_FROM = 1001;
/** How many leads a trial idea may reach before its first sends are judged. */
export const TRIAL_LEADS = 5;
/** Trial ideas open at once, so a planner cannot flood the bank with untested scenes. */
export const TRIAL_OPEN_MAX = 10;
/** Sends an idea needs in a group before its record moves it. Click rates are about 2%. */
export const RECORD_MIN_SENDS = 10;
/** The fewest sends with nothing back that can call an idea a loser. */
export const RECORD_LOSER_SENDS = 30;

/**
 * Sends with nothing back before an idea is called a loser, at this product's response rate.
 *
 * At about 2% clicks an ordinary idea gets no click in 30 sends more than half the time, so a
 * fixed 30 would sink good ideas by bad luck. This is the count at which an idea as good as
 * the average would have a 1 in 10 chance of showing nothing: about 114 sends at 2%.
 */
export function loserSends(average: number): number {
  if (!(average > 0 && average < 1)) return RECORD_LOSER_SENDS;
  return Math.max(RECORD_LOSER_SENDS, Math.ceil(Math.log(0.1) / Math.log(1 - average)));
}

/** An idea used by this many leads in a campaign this week is not offered as a first pick (small campaigns; see ideaLimits). */
export const IDEA_BUSY_AT = 3;
/** A plan step whose ideas are all used by this many other leads this week is refused. */
export const IDEA_CAP = 5;
const WEEK_MS = 7 * 86_400_000;

export interface IdeaLimits {
  busyAt: number;
  cap: number;
}

/**
 * The busy mark and the cap for a campaign of this size.
 *
 * Five leads per idea suits a campaign of fifty. The July–August list has 332 active leads and
 * the bank 50 usable ideas: 250 slots for 332 first plans, so the last 80 leads could not be
 * planned at all. The cap grows to what an even spread of every lead's next plan needs, and
 * never drops below the fixed one, so small campaigns keep spreading as hard as before.
 */
export function ideaLimits(activeLeads: number, usableIdeas: number): IdeaLimits {
  const even = usableIdeas > 0 ? Math.ceil((activeLeads * ROLLING_MAX_STEPS) / usableIdeas) : 0;
  const cap = Math.max(IDEA_CAP, even);
  return { cap, busyAt: Math.max(IDEA_BUSY_AT, Math.ceil(cap * 0.6)) };
}

/**
 * The cap as it applies to one lead: never lower than the least-used idea this lead can still
 * have, plus one.
 *
 * The cap spreads ideas; it must never leave a lead with nothing to plan. When every idea the
 * lead has not had is at the cap (rolling plans re-plan the same lead within a week, so demand
 * outruns the even-spread estimate), the least-used ones stay open. Without this the planner
 * was refused on every pick and retried until its run ran out (2026-09-22: 191 refusals in one
 * run, one lead planned).
 */
export function capFor(cap: number, usage: Map<number, number>, open: Iterable<number>): number {
  let least = Infinity;
  for (const n of open) least = Math.min(least, usage.get(n) ?? 0);
  return Number.isFinite(least) ? Math.max(cap, least + 1) : cap;
}

/** ideaLimits for one campaign, counting the leads it is still writing to. */
export async function ideaLimitsFor(input: { orgId: string; productId: string; goalKey: string; bank: Idea[] }): Promise<IdeaLimits> {
  const db = await getDb();
  const active = await db
    .collection(C.goalInstances)
    .countDocuments({ orgId: input.orgId, productId: input.productId, goalKey: input.goalKey, status: "active" });
  return ideaLimits(active, input.bank.filter((idea) => idea.usable !== false).length);
}

export function ideasOf(product: Document | null | undefined): Idea[] {
  const raw = (product?.config as { writing?: { ideas?: unknown } } | undefined)?.writing?.ideas;
  return Array.isArray(raw) ? (raw as Idea[]).filter((i) => i && Number.isFinite(Number(i.n))) : [];
}

/**
 * Invented ideas live beside the bank, not in it (`config.writing.invented`), so code that
 * knows nothing of the loop keeps reading the approved 88 only.
 */
export function inventedOf(product: Document | null | undefined): InventedIdea[] {
  const raw = (product?.config as { writing?: { invented?: unknown } } | undefined)?.writing?.invented;
  return Array.isArray(raw) ? (raw as InventedIdea[]).filter((i) => i && Number.isFinite(Number(i.n))) : [];
}

/** The ideas a plan may use: the bank, plus invented ones still in play when the loop is on. */
export function ideasFor(product: Document | null | undefined, loop = ideasLoopOn()): Idea[] {
  const bank = ideasOf(product);
  if (!loop) return bank;
  return [...bank, ...inventedOf(product).filter((i) => i.status !== "retired")];
}

export interface IdeaRecord {
  sent: number;
  clicked: number;
  replied: number;
  won: number;
}

export interface IdeaRecords {
  group: Map<number, IdeaRecord>;
  all: Map<number, IdeaRecord>;
  /** Responses per send across every idea: the bar an idea is measured against. */
  average: number;
}

/** The results table folded for one lead's group, and for every group together. */
export function ideaRecords(rows: IdeaRow[], group: string | null | undefined): IdeaRecords {
  const add = (map: Map<number, IdeaRecord>, r: IdeaRow) => {
    const cur = map.get(r.n) ?? { sent: 0, clicked: 0, replied: 0, won: 0 };
    map.set(r.n, { sent: cur.sent + r.sent, clicked: cur.clicked + r.clicked, replied: cur.replied + r.replied, won: cur.won + r.won });
  };
  const records: IdeaRecords = { group: new Map(), all: new Map(), average: 0 };
  let sent = 0;
  let responses = 0;
  for (const r of rows) {
    add(records.all, r);
    if (group && r.group === group) add(records.group, r);
    sent += r.sent;
    responses += r.clicked + r.replied + 3 * r.won;
  }
  records.average = sent ? responses / sent : 0;
  return records;
}

/** The record that speaks for an idea: its own group once that has a few sends, else everyone. */
export function recordFor(n: number, records: IdeaRecords): (IdeaRecord & { scope: "group" | "all" }) | null {
  const own = records.group.get(n);
  if (own && own.sent >= 5) return { ...own, scope: "group" };
  const all = records.all.get(n);
  return all ? { ...all, scope: "all" } : null;
}

/**
 * How far an idea's results move it in the ranking.
 *
 * Below RECORD_MIN_SENDS it is untested and gets a small push, so new and rarely used ideas
 * earn the sends that would prove them. After that its response rate is pulled towards the
 * product's average by ten sends' worth of it, so one lucky click does not crown an idea,
 * and compared: up to three points either way. At loserSends with nothing back it sinks for
 * that group, below any keyword fit.
 */
export function recordScore(n: number, records: IdeaRecords): number {
  const rec = recordFor(n, records);
  if (!rec || rec.sent < RECORD_MIN_SENDS) return 1;
  const responses = rec.clicked + rec.replied + 3 * rec.won;
  if (rec.sent >= loserSends(records.average) && responses === 0) return -20;
  const bar = Math.max(records.average, 0.005);
  const rate = (responses + bar * 10) / (rec.sent + 10);
  return Math.max(-3, Math.min(3, Math.round((rate / bar - 1) * 3)));
}

/** Plain words for a record, as the lead card and the Ideas page show it. */
export function recordText(rec: (IdeaRecord & { scope: "group" | "all" }) | null): string {
  if (!rec || rec.sent === 0) return "not sent yet";
  const parts = [`${rec.sent} sent`, `${rec.clicked} clicked`, `${rec.replied} replied`];
  if (rec.won) parts.push(`${rec.won} signed up`);
  return `${parts.join(" · ")}${rec.scope === "group" ? " (leads like this one)" : " (all leads)"}`;
}

const words = (text: string) => new Set(String(text ?? "").toLowerCase().match(/[a-z₹]{3,}/g) ?? []);

/**
 * How much what they said after arriving (lead.said: CRM notes, their own WhatsApp messages)
 * lifts each idea. Matched against what each idea proves. A word few proofs share names a
 * part of the product ("CRM" after a walk-through), and every idea proving that part is lifted
 * by the same amount, clear of the keyword fit; a word most proofs share ("team", "hours")
 * names nothing and lifts nothing.
 */
export function saidScores(ideas: Idea[], said: string | undefined): Map<number, number> {
  const heard = heardWords(said);
  const scores = new Map<number, number>();
  if (heard.size === 0) return scores;
  // The proof only: keywords tag a scene ("crm" sits on every sales-team story), the proof is
  // what the product does about it, and a need names what the product should do.
  const proves = new Map(ideas.map((idea) => [idea.n, words(idea.proof ?? "")]));
  const spread = new Map<string, number>();
  for (const set of proves.values()) for (const w of set) if (heard.has(w)) spread.set(w, (spread.get(w) ?? 0) + 1);
  const rare = Math.max(3, Math.round(ideas.length / 10));
  for (const [n, set] of proves) {
    const named = [...set].filter((w) => (spread.get(w) ?? Infinity) <= rare).length;
    if (named) scores.set(n, 6 * named);
  }
  return scores;
}

/**
 * The bank ranked for one lead: their own words (the problem they typed, their role, what
 * their company says it does) against each idea's keywords and title, what they said since
 * (saidScores), their segment, and a penalty for ideas the campaign has leaned on this week.
 * Ideas they already had come last.
 */
export function rankIdeas(
  ideas: Idea[],
  lead: { text: string; said?: string; segment?: string | null },
  usage: Map<number, number>,
  had: Set<number>,
  limits: IdeaLimits = { busyAt: IDEA_BUSY_AT, cap: IDEA_CAP },
  records?: IdeaRecords,
): Array<Idea & { score: number; used_this_week: number; already_had: boolean; record?: string }> {
  const leadWords = words(lead.text);
  const heard = saidScores(ideas, lead.said);
  return ideas
    .filter((idea) => idea.usable !== false)
    .map((idea) => {
      let score = 0;
      for (const k of idea.keywords ?? []) if (leadWords.has(String(k).toLowerCase())) score += 2;
      // Its other shapes count too: "WhatsApp", "GST", "dispatch" may only be in one of them.
      for (const w of words(`${idea.title} ${idea.detail ?? ""} ${(idea.also ?? []).join(" ")}`)) if (leadWords.has(w)) score += 1;
      if (lead.segment && (idea.segments ?? []).includes(lead.segment)) score += 2;
      score += heard.get(idea.n) ?? 0;
      const used = usage.get(idea.n) ?? 0;
      if (used >= limits.busyAt) score -= 2 * (used - limits.busyAt + 1);
      // plan_goal refuses a step whose ideas are all at the cap, so the card never leads with one.
      if (used >= limits.cap) score -= 50;
      const alreadyHad = had.has(idea.n);
      if (alreadyHad) score -= 100;
      if (!records) return { ...idea, score, used_this_week: used, already_had: alreadyHad };
      score += recordScore(idea.n, records);
      return { ...idea, score, used_this_week: used, already_had: alreadyHad, record: recordText(recordFor(idea.n, records)) };
    })
    .sort((a, b) => b.score - a.score || a.n - b.n);
}

/** How many leads in this campaign had each idea planned in the last week, the lead itself left out. */
export async function ideaUsage(input: { orgId: string; productId: string; goalKey: string; excludeInstanceId?: string; now?: Date }): Promise<Map<number, number>> {
  const db = await getDb();
  const since = new Date((input.now ?? new Date()).getTime() - WEEK_MS);
  const instances = await db
    .collection(C.goalInstances)
    .find({ orgId: input.orgId, productId: input.productId, goalKey: input.goalKey }, { projection: { _id: 1 } })
    .toArray();
  const ids = instances.map((i) => String(i._id)).filter((id) => id !== input.excludeInstanceId);
  if (ids.length === 0) return new Map();
  const plans = await db
    .collection(C.plans)
    .find({ orgId: input.orgId, goalInstanceId: { $in: ids }, createdAt: { $gte: since }, rolling: true }, { projection: { goalInstanceId: 1, steps: 1 } })
    .toArray();
  const perIdea = new Map<number, Set<string>>();
  for (const plan of plans) {
    for (const step of (plan.steps ?? []) as Array<{ idea_refs?: unknown }>) {
      for (const n of Array.isArray(step.idea_refs) ? step.idea_refs : []) {
        const key = Number(n);
        if (!Number.isFinite(key)) continue;
        if (!perIdea.has(key)) perIdea.set(key, new Set());
        perIdea.get(key)!.add(String(plan.goalInstanceId));
      }
    }
  }
  return new Map([...perIdea.entries()].map(([n, set]) => [n, set.size]));
}

/** The ideas this lead has already been sent, from the plans behind the messages that went out. */
export async function ideasHadBy(input: { orgId: string; goalInstanceId: string }): Promise<Set<number>> {
  const db = await getDb();
  const sent = await db
    .collection(C.actions)
    .find({ orgId: input.orgId, goalInstanceId: input.goalInstanceId, status: { $in: ["sent", "dispatched"] } }, { projection: { ideaRefs: 1, planStepId: 1 } })
    .toArray();
  const had = new Set<number>();
  for (const a of sent) for (const n of (a.ideaRefs ?? []) as unknown[]) if (Number.isFinite(Number(n))) had.add(Number(n));
  // Messages sent before actions carried their ideas: read them off the plans that named them.
  const plans = await db
    .collection(C.plans)
    .find({ orgId: input.orgId, goalInstanceId: input.goalInstanceId }, { projection: { steps: 1 } })
    .toArray();
  const sentSteps = new Set(sent.map((a) => Number(a.planStepId)).filter((n) => Number.isFinite(n)));
  for (const plan of plans) {
    for (const step of (plan.steps ?? []) as Array<{ id?: unknown; idea_refs?: unknown }>) {
      if (!sentSteps.has(Number(step.id))) continue;
      for (const n of Array.isArray(step.idea_refs) ? step.idea_refs : []) if (Number.isFinite(Number(n))) had.add(Number(n));
    }
  }
  return had;
}

/** How many leads have ever had this idea in a plan, in any campaign of the product. */
export async function ideaLeadCount(input: { orgId: string; productId: string; n: number; excludeInstanceId?: string }): Promise<number> {
  const db = await getDb();
  const ids = await db
    .collection(C.plans)
    .distinct("goalInstanceId", { orgId: input.orgId, productId: input.productId, rolling: true, "steps.idea_refs": input.n });
  return ids.map(String).filter((id) => id !== input.excludeInstanceId).length;
}

/** The next free number for an invented idea. */
export function nextInventedN(invented: InventedIdea[]): number {
  return Math.max(INVENTED_FROM - 1, ...invented.map((i) => Number(i.n))) + 1;
}

async function setInventedStatus(productId: string, n: number, status: InventedIdea["status"], reason: string): Promise<void> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  await db.collection(C.products).updateOne(
    { _id: new ObjectId(productId) },
    { $set: { "config.writing.invented.$[i].status": status, "config.writing.invented.$[i].statusReason": reason, "config.writing.invented.$[i].statusAt": new Date() } },
    { arrayFilters: [{ "i.n": n }] },
  );
}

/** A person moves an invented idea by hand, from the Ideas page. */
export async function setInventedIdeaStatus(input: { orgId: string; productId: string; n: number; status: InventedIdea["status"]; reason: string }): Promise<void> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(input.productId), orgId: input.orgId }, { projection: { "config.writing.invented": 1 } });
  if (!inventedOf(product).some((i) => i.n === input.n)) throw new Error(`No invented idea #${input.n} on this product.`);
  await setInventedStatus(input.productId, input.n, input.status, input.reason);
}

/**
 * Moves invented ideas on from what their sends did.
 *
 * A trial idea reached its TRIAL_LEADS and they were sent: an unsubscribe from any of those
 * readers retires it, otherwise it becomes active and is ranked like the bank. An active one
 * with loserSends sends and nothing back retires. Every move keeps its reason.
 */
export async function reviewInventedIdeas(orgId: string, productId: string): Promise<Array<{ n: number; title: string; from: string; to: string; reason: string }>> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId }, { projection: { "config.writing.invented": 1 } });
  const moves: Array<{ n: number; title: string; from: string; to: string; reason: string }> = [];
  const lossAt = loserSends(ideaRecords(await ideaPerformance(orgId, productId), null).average);
  for (const idea of inventedOf(product).filter((i) => i.status !== "retired")) {
    const sent = await db
      .collection(C.actions)
      .find({ orgId, productId, ideaRefs: idea.n, status: { $in: ["sent", "dispatched"] }, dryRun: { $ne: true } }, { projection: { personId: 1, sentAt: 1, firstClickedAt: 1, firstRepliedAt: 1, goalOutcome: 1 } })
      .toArray();
    const responses = sent.filter((a) => a.firstClickedAt || a.firstRepliedAt || a.goalOutcome === "won").length;
    let to: InventedIdea["status"] | null = null;
    let reason = "";
    if (idea.status === "trial" && sent.length >= TRIAL_LEADS) {
      const people = await db
        .collection(C.people)
        .find({ _id: { $in: sent.map((a) => new ObjectId(String(a.personId))) } }, { projection: { primaryEmail: 1 } })
        .toArray();
      const firstSent = new Date(Math.min(...sent.map((a) => new Date(String(a.sentAt)).getTime())));
      const optedOut = await db.collection(C.suppressions).countDocuments({
        orgId,
        identityValue: { $in: people.flatMap((p) => [String(p.primaryEmail ?? ""), String(p.primaryEmail ?? "").toLowerCase()]).filter(Boolean) },
        // Any opt-out counts (link, "remove me" reply, spam complaint); a bounce is the address, not the idea.
        reason: { $not: /bounce/i },
        at: { $gte: firstSent },
      });
      if (optedOut) {
        to = "retired";
        reason = `${optedOut} of its first ${sent.length} readers unsubscribed or complained`;
      } else {
        to = "active";
        reason = `sent to ${sent.length} leads with no unsubscribe (${responses} clicked or replied); now ranked like the bank`;
      }
    } else if (idea.status === "active" && sent.length >= lossAt && responses === 0) {
      to = "retired";
      reason = `${sent.length} sends and nobody clicked or replied`;
    }
    if (!to) continue;
    await setInventedStatus(productId, idea.n, to, reason);
    moves.push({ n: idea.n, title: idea.title, from: idea.status, to, reason });
  }
  return moves;
}
