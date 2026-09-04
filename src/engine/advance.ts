import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { dueAtFor, type CadenceBand } from "./cadence.js";
import { PRIORITY, enqueueMany } from "./queue.js";
import { pickChannelFrom, loadChannels } from "./channels.js";
import type { ChannelKey } from "../schemas/common.js";

/**
 * Turning a plan into messages, on the clock, for everybody.
 *
 * Until now the only thing that could produce a follow-up was a Claude session: the plan
 * named an angle, and a session had to write the words before an action existed at all.
 * That put a model in the path of every touch for every person, which is why thirty touches
 * an hour had to cover fifteen hundred a day, and why a person whose session never came
 * round simply stopped receiving mail with no error anywhere.
 *
 * Here the engine creates the action from the plan step, and what varies is only who fills
 * the slot. Most people get the template's own copy, merged with their name and their
 * segment's pain — which is what they were getting anyway, since the composed copy was
 * being discarded at render time. The few who have earned it get a session's writing.
 */

export type Tier = 1 | 2 | 3;

export interface AdvanceSummary {
  examined: number;
  queued: number;
  handedToClaude: number;
  parked: number;
  skipped: Array<{ goalInstanceId: string; reason: string }>;
}

/**
 * Which people are worth a model call.
 *
 * Tier 1 is not "our best leads" — it is people who have done something we can point at, or
 * who fit well enough that a generic message is a waste of the one chance. Everyone else is
 * tier 2, which is not a lesser message: it renders through the same templates, the same
 * brand kit, the same claims validation and the same governor.
 */
export function tierFor(person: Document, goalInstance: Document): Tier {
  const budget = (goalInstance.spent as { touches?: number } | undefined)?.touches ?? 0;
  const deadline = goalInstance.deadline ? new Date(String(goalInstance.deadline)) : undefined;
  if (deadline && deadline <= new Date()) return 3;

  const band = (person.temp as { band?: string } | undefined)?.band;
  if (band === "dead") return 3;
  if (person.lifecycle === "suppressed" || person.suppressedAt) return 3;

  const belief = (person.belief as { icpFit?: number; fitKnown?: boolean } | undefined) ?? {};
  const replied = Boolean(person.lastReplyAt);
  if (band === "hot" || replied) return 1;
  // A strong fit is worth one good message rather than five generic ones, but only while
  // the sequence still has room to use it.
  if ((belief.icpFit ?? 0) >= 0.7 && belief.fitKnown !== false && budget < 4) return 1;
  return 2;
}

/**
 * The step a plan is up to: the lowest-numbered one nothing has been written for yet.
 *
 * With one exception, at the very start of a sequence. The engine queues a first touch the
 * moment a lead lands — it does not wait for a plan, because speed to lead is worth more
 * than the personalisation a session would add — and a plan written afterwards almost
 * always opens with a welcome of its own. Both are correct in isolation and together they
 * put the identical "your workspace is ready" in front of the same person twice.
 *
 * So while nothing from the plan has been written yet, a leading step whose angle has
 * already been delivered is treated as spent and skipped. Only the leading steps, and only
 * before the plan has done anything: past that point a repeated angle can be deliberate —
 * an angle somebody clicked is not spent, it reached them and the ask was wrong — and that
 * is a judgement for the routine that rewrote their plan, not for this loop.
 */
export function nextStep(plan: Document | null, written: Set<number>, delivered: Set<string> = new Set()): Document | null {
  const steps = ((plan?.steps ?? []) as Document[]).slice().sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
  const planStarted = steps.some((step) => written.has(Number(step.id ?? step.step_id ?? 0)));

  for (const step of steps) {
    const id = Number(step.id ?? step.step_id ?? 0);
    if (!Number.isFinite(id) || id === 0) continue;
    if (written.has(id)) continue;
    if (!planStarted && delivered.has(String(step.angle ?? "").toLowerCase())) continue;
    return { ...step, id };
  }
  return null;
}

/**
 * Walks active campaigns and gives each person their next message.
 *
 * Bounded per run and ordered by who has waited longest, so a product with fifty thousand
 * people in flight makes progress on all of them across successive ticks rather than
 * repeatedly serving whichever rows the index happened to return first.
 */
export async function advance(
  orgId: string,
  productId: string,
  limit = 100,
  now = new Date(),
  deadline = Date.now() + 10_000,
): Promise<AdvanceSummary> {
  const db = await getDb();
  const summary: AdvanceSummary = { examined: 0, queued: 0, handedToClaude: 0, parked: 0, skipped: [] };
  const s = { orgId, productId };

  const instances = await db
    .collection(C.goalInstances)
    .find(
      { ...s, status: "active", currentPlanId: { $exists: true } },
      { projection: { personId: 1, goalKey: 1, currentPlanId: 1, spent: 1, deadline: 1 } },
    )
    .sort({ lastAdvancedAt: 1, startedAt: 1 })
    .limit(limit)
    .toArray();
  if (instances.length === 0) return summary;
  // The cluster this runs against is shared, and a query that usually costs a second has
  // been seen to cost twenty. Checking here as well as in the loop means a slow moment
  // costs a batch rather than the whole tick, which still has mail to reconcile after this.
  if (Date.now() > deadline) return summary;

  const instanceIds = instances.map((i) => String(i._id));

  // Everything this loop needs, read in five queries rather than five per person.
  //
  // The per-person version was correct and far too slow to run on a minute clock: a round
  // trip to a hosted cluster is about forty milliseconds, so two hundred people at five
  // round trips each is thirty-nine seconds inside a function the platform kills at sixty.
  // The tick would send its mail, then die before recording anything — which from outside
  // looks exactly like a system that is working.
  // Projected down to what the decision actually reads. A person document is about 1.5KB
  // and only six of its fields matter here; over two hundred people that is the difference
  // between a payload worth waiting for and one worth timing out over.
  const [goals, people, plans, actionRows] = await Promise.all([
    db.collection(C.goals).find(s).toArray(),
    db
      .collection(C.people)
      .find(
        { _id: { $in: instances.map((i) => new ObjectId(String(i.personId))) } },
        { projection: { temp: 1, belief: 1, lifecycle: 1, suppressedAt: 1, lastReplyAt: 1, lastContactedAt: 1, consent: 1, stage: 1 } },
      )
      .toArray(),
    db
      .collection(C.plans)
      .find(
        { _id: { $in: instances.map((i) => new ObjectId(String(i.currentPlanId))) } },
        { projection: { steps: 1 } },
      )
      .toArray(),
    db
      .collection(C.actions)
      .find(
        { ...s, goalInstanceId: { $in: instanceIds } },
        { projection: { goalInstanceId: 1, planStepId: 1, status: 1, angle: 1 } },
      )
      .toArray(),
  ]);

  const goalByKey = new Map(goals.map((g) => [String(g.key), g]));
  const personById = new Map(people.map((p) => [String(p._id), p]));
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  const pendingBy = new Map<string, number>();
  const writtenBy = new Map<string, Set<number>>();
  /** Angles this person has already been given, whatever produced them. */
  const deliveredBy = new Map<string, Set<string>>();
  for (const action of actionRows) {
    const key = String(action.goalInstanceId);
    if (["queued", "awaiting_approval", "sending"].includes(String(action.status))) {
      pendingBy.set(key, (pendingBy.get(key) ?? 0) + 1);
    }
    const step = Number(action.planStepId);
    if (Number.isFinite(step)) {
      const set = writtenBy.get(key) ?? new Set<number>();
      set.add(step);
      writtenBy.set(key, set);
    }
    // A message that was skipped or failed never reached anyone, so its angle is not spent.
    if (["queued", "awaiting_approval", "sending", "sent", "dispatched"].includes(String(action.status))) {
      const angles = deliveredBy.get(key) ?? new Set<string>();
      angles.add(String(action.angle ?? "").toLowerCase());
      deliveredBy.set(key, angles);
    }
  }

  // Channels are the same handful of documents for everyone in the batch, so they are read
  // once per campaign and the per-person decision is made in memory.
  const channelsByGoal = new Map<string, Record<string, unknown>[]>();
  for (const goal of goals) {
    channelsByGoal.set(
      String(goal.key),
      await loadChannels(orgId, productId, (goal.allowedChannels ?? ["email"]) as ChannelKey[]),
    );
  }

  const advancedIds: ObjectId[] = [];
  const toInsert: Document[] = [];
  const handOver: Array<{ subjectId: string; payload: Record<string, unknown>; productId: string; campaignKey: string; priority: number }> = [];

  for (const instance of instances) {
    if (Date.now() > deadline) break;
    summary.examined++;
    const goalInstanceId = String(instance._id);
    // Stamped whatever happens, so a campaign that cannot advance today drops to the back of
    // the queue instead of being re-examined on every single tick forever.
    advancedIds.push(instance._id as ObjectId);

    const goal = goalByKey.get(String(instance.goalKey));
    if (!goal) {
      summary.skipped.push({ goalInstanceId, reason: "campaign definition missing" });
      continue;
    }

    const budget = (goal.budget ?? {}) as { touches?: number };
    const spent = Number((instance.spent as { touches?: number } | undefined)?.touches ?? 0);
    if (budget.touches !== undefined && spent >= budget.touches) {
      summary.parked++;
      continue;
    }

    // Anything already waiting means this person's next message exists. Writing a second one
    // now would put two messages in front of somebody who has read neither.
    if ((pendingBy.get(goalInstanceId) ?? 0) > 0) continue;

    const person = personById.get(String(instance.personId));
    if (!person) {
      summary.skipped.push({ goalInstanceId, reason: "person missing" });
      continue;
    }

    const tier = tierFor(person, instance);
    if (tier === 3) {
      summary.parked++;
      continue;
    }

    const step = nextStep(
      planById.get(String(instance.currentPlanId)) ?? null,
      writtenBy.get(goalInstanceId) ?? new Set(),
      deliveredBy.get(goalInstanceId) ?? new Set(),
    );
    if (!step) {
      summary.skipped.push({ goalInstanceId, reason: "plan exhausted" });
      continue;
    }

    const band = (person.temp as { band?: string } | undefined)?.band;
    const dueAt = dueAtFor({
      offsetDays: Number(step.offsetDays ?? step.after_days ?? 3),
      band,
      lastContactedAt: person.lastContactedAt as Date | undefined,
      configured: goal.cadenceByTemp as Record<string, CadenceBand> | undefined,
      now,
    });

    // Tier 1 is handed to a session rather than written here. The action is not created yet:
    // whoever writes the copy also decides the shape, and creating an empty shell now would
    // race the session that is about to fill it.
    if (tier === 1) {
      handOver.push({
        subjectId: goalInstanceId,
        payload: { goalInstanceId, personId: String(person._id), stepId: step.id, dueAt },
        productId,
        campaignKey: String(instance.goalKey),
        priority: band === "hot" ? PRIORITY.urgent : PRIORITY.normal,
      });
      summary.handedToClaude++;
      continue;
    }

    // The campaign's allowed channels are the outer bound; the step's preference is tried
    // first inside it. A plan naming a channel the campaign never allowed is not honoured —
    // that is the campaign's decision to make, not a plan's.
    const allowed = (goal.allowedChannels ?? ["email"]) as ChannelKey[];
    const channels = channelsByGoal.get(String(goal.key)) ?? [];
    const pick =
      pickChannelFrom(channels, allowed.filter((key) => key === String(step.channel)), person as never) ??
      pickChannelFrom(channels, allowed, person as never);
    if (!pick) {
      summary.skipped.push({ goalInstanceId, reason: "no healthy channel" });
      continue;
    }

    toInsert.push({
      _id: new ObjectId(),
      orgId,
      productId,
      goalInstanceId,
      personId: String(person._id),
      planStepId: step.id,
      channel: pick.key,
      channelId: pick.channelId,
      angle: String(step.angle ?? "follow_up"),
      rationale: String(step.why ?? `Plan step ${step.id}; ${pick.reason}.`),
      // No template id and no composed copy. The ladder rung is chosen at send time from how
      // far through the sequence this person is, and its own fallback text is the message —
      // which is what tier 2 means.
      status: "queued",
      dueAt,
      cost: 0,
      signals: [],
      next: {},
      content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
      assetIds: [],
      idempotencyKey: `${goalInstanceId}:step:${step.id}`,
    });
  }

  if (advancedIds.length) {
    await db
      .collection(C.goalInstances)
      .updateMany({ _id: { $in: advancedIds } }, { $set: { lastAdvancedAt: now } });
  }

  if (toInsert.length) {
    try {
      const result = await db.collection(C.actions).insertMany(toInsert, { ordered: false });
      summary.queued += result.insertedCount;
    } catch (err) {
      // Duplicate keys are the unique index doing its job: a session wrote the same step
      // between the read above and this insert. Theirs wins; it has words in it.
      const inserted = insertedDespiteDuplicates(err);
      if (inserted === null) throw err;
      summary.queued += inserted;
    }
  }

  if (handOver.length) await enqueueMany(orgId, "compose", handOver, now);

  return summary;
}

/** A duplicate key is the unique index doing its job. Anything else is a real failure. */
function insertedDespiteDuplicates(err: unknown): number | null {
  const bulk = err as { result?: { insertedCount?: number }; writeErrors?: { code?: number }[] };
  const writeErrors = bulk?.writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.some((e) => e.code !== 11000)) return null;
  return bulk.result?.insertedCount ?? 0;
}
