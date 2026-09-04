import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { dueAtFor, type CadenceBand } from "./cadence.js";
import { PRIORITY, enqueue } from "./queue.js";
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

/** The step a plan is up to: the lowest-numbered one nothing has been written for yet. */
function nextStep(plan: Document | null, written: Set<number>): Document | null {
  const steps = ((plan?.steps ?? []) as Document[]).slice().sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
  for (const step of steps) {
    const id = Number(step.id ?? step.step_id ?? 0);
    if (!Number.isFinite(id) || id === 0) continue;
    if (!written.has(id)) return { ...step, id };
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
  limit = 200,
  now = new Date(),
): Promise<AdvanceSummary> {
  const db = await getDb();
  const summary: AdvanceSummary = { examined: 0, queued: 0, handedToClaude: 0, parked: 0, skipped: [] };
  const s = { orgId, productId };

  const instances = await db
    .collection(C.goalInstances)
    .find({ ...s, status: "active", currentPlanId: { $exists: true } })
    .sort({ lastAdvancedAt: 1, startedAt: 1 })
    .limit(limit)
    .toArray();
  if (instances.length === 0) return summary;

  const goals = await db.collection(C.goals).find(s).toArray();
  const goalByKey = new Map(goals.map((g) => [String(g.key), g]));

  for (const instance of instances) {
    summary.examined++;
    const goalInstanceId = String(instance._id);
    // Stamped before any early `continue`, so a campaign that cannot advance today drops to
    // the back of the queue instead of being re-examined on every single tick forever.
    await db
      .collection(C.goalInstances)
      .updateOne({ _id: instance._id }, { $set: { lastAdvancedAt: now } });

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

    // Anything already waiting means this person's next message exists. Writing a second
    // one now would put two messages in front of somebody who has read neither.
    const pending = await db
      .collection(C.actions)
      .countDocuments({ ...s, goalInstanceId, status: { $in: ["queued", "awaiting_approval", "sending"] } });
    if (pending > 0) continue;

    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) });
    if (!person) {
      summary.skipped.push({ goalInstanceId, reason: "person missing" });
      continue;
    }

    const tier = tierFor(person, instance);
    if (tier === 3) {
      summary.parked++;
      continue;
    }

    const plan = await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) });
    const writtenIds = (
      await db
        .collection(C.actions)
        .find({ ...s, goalInstanceId }, { projection: { planStepId: 1 } })
        .toArray()
    )
      .map((a) => Number(a.planStepId))
      .filter(Number.isFinite);

    const step = nextStep(plan, new Set(writtenIds));
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

    // Tier 1 is handed to a session rather than written here. The action is not created
    // yet: whoever writes the copy also decides the shape, and creating an empty shell now
    // would race the session that is about to fill it.
    if (tier === 1) {
      await enqueue(
        orgId,
        "compose",
        { goalInstanceId, personId: String(person._id), stepId: step.id, dueAt },
        {
          productId,
          campaignKey: String(instance.goalKey),
          subjectId: goalInstanceId,
          priority: band === "hot" ? PRIORITY.urgent : PRIORITY.normal,
        },
      );
      summary.handedToClaude++;
      continue;
    }

    // The campaign's allowed channels are the outer bound; the step's preference is tried
    // first inside it. A plan naming a channel the campaign never allowed is not honoured —
    // that is the campaign's decision to make, not a plan's.
    const allowed = (goal.allowedChannels ?? ["email"]) as ChannelKey[];
    const preferred = allowed.filter((key) => key === String(step.channel));
    const channels = await loadChannels(orgId, productId, allowed);
    const pick =
      pickChannelFrom(channels, preferred, person as never) ??
      pickChannelFrom(channels, allowed, person as never);
    if (!pick) {
      summary.skipped.push({ goalInstanceId, reason: "no healthy channel" });
      continue;
    }

    try {
      await db.collection(C.actions).insertOne({
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
        // No template id and no composed copy. The ladder rung is chosen at send time from
        // how far through the sequence this person is, and its own fallback text is the
        // message — which is what tier 2 means.
        status: "queued",
        dueAt,
        cost: 0,
        signals: [],
        next: {},
        content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
        assetIds: [],
        idempotencyKey: `${goalInstanceId}:step:${step.id}`,
      });
      summary.queued++;
    } catch (err) {
      // The unique index doing its job: a session wrote this same step between the read
      // above and this insert. Theirs wins; it has words in it.
      if (!(err instanceof Error && err.message.includes("E11000"))) throw err;
    }
  }

  return summary;
}
