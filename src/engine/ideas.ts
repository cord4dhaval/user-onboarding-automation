import type { Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ROLLING_MAX_STEPS } from "./rolling.js";

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

const words = (text: string) => new Set(String(text ?? "").toLowerCase().match(/[a-z₹]{3,}/g) ?? []);

/**
 * The bank ranked for one lead: their own words (the problem they typed, their role, what
 * their company says it does) against each idea's keywords and title, their segment, and a
 * penalty for ideas the campaign has leaned on this week. Ideas they already had come last.
 */
export function rankIdeas(
  ideas: Idea[],
  lead: { text: string; segment?: string | null },
  usage: Map<number, number>,
  had: Set<number>,
  limits: IdeaLimits = { busyAt: IDEA_BUSY_AT, cap: IDEA_CAP },
): Array<Idea & { score: number; used_this_week: number; already_had: boolean }> {
  const leadWords = words(lead.text);
  return ideas
    .filter((idea) => idea.usable !== false)
    .map((idea) => {
      let score = 0;
      for (const k of idea.keywords ?? []) if (leadWords.has(String(k).toLowerCase())) score += 2;
      for (const w of words(`${idea.title} ${idea.detail ?? ""}`)) if (leadWords.has(w)) score += 1;
      if (lead.segment && (idea.segments ?? []).includes(lead.segment)) score += 2;
      const used = usage.get(idea.n) ?? 0;
      if (used >= limits.busyAt) score -= 2 * (used - limits.busyAt + 1);
      // plan_goal refuses a step whose ideas are all at the cap, so the card never leads with one.
      if (used >= limits.cap) score -= 50;
      const alreadyHad = had.has(idea.n);
      if (alreadyHad) score -= 100;
      return { ...idea, score, used_this_week: used, already_had: alreadyHad };
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
