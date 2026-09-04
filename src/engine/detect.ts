import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { PRIORITY, enqueue, enqueueMany } from "./queue.js";

/**
 * Noticing what needs a session's attention, on the minute clock, without a model.
 *
 * Every condition here is a database question with an unambiguous answer: this person has
 * no belief, that campaign has no plan, this one just went hot. A routine could ask the
 * same questions itself, but only once an hour and only across the slice it managed to
 * read — which is how a product ends up with nine thousand people nobody has looked at and
 * a routine that reports nothing to do.
 *
 * Detecting and doing are separated on purpose. This runs constantly and cheaply and
 * writes down what it found; the dispatcher decides whose turn it is; the hourly routines
 * do the work. Nothing is lost if any of the three is down, because the finding is a row.
 */

export interface DetectSummary {
  classify: number;
  compose: number;
  monitor: number;
  escalate: number;
  playbook: number;
}

export async function detectWork(
  orgId: string,
  productId: string,
  now = new Date(),
  deadline = Date.now() + 8_000,
): Promise<DetectSummary> {
  const db = await getDb();
  const summary: DetectSummary = { classify: 0, compose: 0, monitor: 0, escalate: 0, playbook: 0 };
  const s = { orgId, productId };

  // Bounded by rows and by wall clock, because the two run out at different times. The
  // clock comes round again in a minute, and a tick that tries to enqueue a hundred
  // thousand rows is a tick that is killed mid-write and enqueues none of them.
  const BATCH = 500;
  const outOfTime = () => Date.now() > deadline;

  // ── people nobody has read yet ────────────────────────────────────────────────
  const unclassified = await db
    .collection(C.people)
    .find({ ...s, needsClassification: true, suppressedAt: { $exists: false } })
    .sort({ createdAt: 1 })
    .limit(BATCH)
    .project({ _id: 1 })
    .toArray();

  if (unclassified.length) {
    // The campaign each person entered on, read in one query rather than one per person.
    // Fairness is applied per campaign, so ten campaigns under one product are ten queues.
    const instances = await db
      .collection(C.goalInstances)
      .find(
        { ...s, personId: { $in: unclassified.map((p) => String(p._id)) } },
        { projection: { personId: 1, goalKey: 1 } },
      )
      .toArray();
    const campaignOf = new Map(instances.map((i) => [String(i.personId), String(i.goalKey)]));

    summary.classify = await enqueueMany(
      orgId,
      "classify",
      unclassified.map((person) => ({
        subjectId: String(person._id),
        payload: { personId: String(person._id) },
        productId,
        campaignKey: campaignOf.get(String(person._id)) ?? "unassigned",
        priority: PRIORITY.normal,
      })),
      now,
    );
  }
  if (outOfTime()) return summary;

  // ── campaigns due another look ───────────────────────────────────────────────
  //
  // Composing is not queued here. `advance` walks the same campaigns, works out whose next
  // step is actually due and what tier they are in, and hands over only the tier that earns
  // a model call. Queuing one from here as well would ask a session to write for everybody,
  // which is the cost this whole design exists to avoid.
  const due = await db
    .collection(C.goalInstances)
    .find({
      ...s,
      status: "active",
      $or: [{ nextVerifyAt: { $lte: now } }, { nextVerifyAt: { $exists: false } }],
    })
    .sort({ nextVerifyAt: 1 })
    .limit(BATCH)
    .project({ _id: 1, goalKey: 1, personId: 1 })
    .toArray();

  if (due.length) {
    summary.monitor = await enqueueMany(
      orgId,
      "monitor",
      due.map((instance) => ({
        subjectId: String(instance._id),
        payload: { goalInstanceId: String(instance._id), personId: String(instance.personId) },
        productId,
        campaignKey: String(instance.goalKey),
        priority: PRIORITY.background,
      })),
      now,
    );
  }
  if (outOfTime()) return summary;

  // ── campaigns and segments with no sequence to run ───────────────────────────
  //
  // The one gap that makes everything else pointless: a campaign whose default playbook is
  // missing has nothing to stamp onto arrivals, so every person entering it waits on a
  // session before they have any sequence at all — which is exactly the dependency this
  // design exists to remove.
  const campaigns = await db.collection(C.goals).find({ ...s, enabled: true }).toArray();
  if (campaigns.length === 0) return summary;

  const existing = await db
    .collection(C.playbooks)
    .find({ ...s }, { projection: { goalKey: 1, segmentKey: 1 } })
    .toArray();
  const written = new Set(existing.map((p) => `${String(p.goalKey)}:${String(p.segmentKey)}`));

  // A segment only earns its own sequence once enough people are in it to be worth writing
  // one — and to have anything to learn from afterwards. Below that they run the campaign
  // default, which is a real sequence, not a placeholder.
  const segments = (await db
    .collection(C.people)
    .aggregate([
      { $match: { ...s, "belief.segment": { $exists: true } } },
      { $group: { _id: "$belief.segment", people: { $sum: 1 } } },
      { $match: { people: { $gte: SEGMENT_PLAYBOOK_FLOOR } } },
    ])
    .toArray()) as Array<{ _id: string; people: number }>;

  const wanted: Array<{ subjectId: string; payload: Record<string, unknown>; productId: string; campaignKey: string; priority: number }> = [];
  for (const goal of campaigns) {
    const goalKey = String(goal.key);
    if (!written.has(`${goalKey}:default`)) {
      wanted.push({
        subjectId: `${goalKey}:default`,
        payload: { goalKey, segmentKey: "default" },
        productId,
        campaignKey: goalKey,
        priority: PRIORITY.normal,
      });
    }
    for (const segment of segments) {
      const segmentKey = String(segment._id);
      if (segmentKey === "off_icp" || segmentKey === "unknown") continue;
      if (written.has(`${goalKey}:${segmentKey}`)) continue;
      wanted.push({
        subjectId: `${goalKey}:${segmentKey}`,
        payload: { goalKey, segmentKey, people: segment.people },
        productId,
        campaignKey: goalKey,
        priority: PRIORITY.background,
      });
    }
  }
  if (wanted.length) summary.playbook = await enqueueMany(orgId, "playbook", wanted, now);

  return summary;
}

/**
 * How many people a segment needs before it is worth its own sequence.
 *
 * Below this, a per-segment playbook is a maintenance burden with nothing to learn from:
 * an angle's performance inside a bucket of three is noise. The campaign default is a real
 * sequence, so running it is not a penalty.
 */
const SEGMENT_PLAYBOOK_FLOOR = 25;

/**
 * Someone moved. This is the only path that produces urgent work.
 *
 * Called from the signal lane rather than polled, because the engine already knows the
 * moment a click, an open or a reply lands, and the value of reacting decays in hours.
 */
export async function detectMovement(
  orgId: string,
  productId: string,
  input: { personId: string; goalInstanceId?: string; campaignKey?: string; reason: string },
): Promise<void> {
  const db = await getDb();
  const goalInstanceId =
    input.goalInstanceId ??
    String(
      (
        await db
          .collection(C.goalInstances)
          .findOne({ orgId, productId, personId: input.personId, status: "active" }, { projection: { _id: 1, goalKey: 1 } })
      )?._id ?? "",
    );
  if (!goalInstanceId) return;

  const campaignKey =
    input.campaignKey ??
    String(
      (
        await db
          .collection(C.goalInstances)
          .findOne({ _id: new ObjectId(goalInstanceId) }, { projection: { goalKey: 1 } })
      )?.goalKey ?? "unassigned",
    );

  await enqueue(
    orgId,
    "escalate",
    { personId: input.personId, goalInstanceId, reason: input.reason },
    { productId, campaignKey, subjectId: input.personId, priority: PRIORITY.urgent },
  );
}

export interface WatchdogSummary {
  overdue: number;
  oldestMinutes: number;
  sample: Array<{ actionId: string; personId: string; minutesLate: number }>;
}

/**
 * Messages that were due and never went out.
 *
 * Every guardrail in the send path has a state it moves an action into — deferred, skipped,
 * failed, awaiting approval — so a message sitting at `queued` long past its time is not
 * being held back by anything. It has been forgotten. Seventy-one of them were, and the
 * only reason anyone found out was a person opening the database by hand a day later.
 */
export async function watchdog(
  orgId: string,
  productId: string,
  now = new Date(),
  graceMs = 2 * 3_600_000,
): Promise<WatchdogSummary> {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - graceMs);

  const late = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "queued", dueAt: { $lte: cutoff } })
    .sort({ dueAt: 1 })
    .limit(50)
    .project({ _id: 1, personId: 1, dueAt: 1 })
    .toArray();

  const overdue = await db
    .collection(C.actions)
    .countDocuments({ orgId, productId, status: "queued", dueAt: { $lte: cutoff } });

  const oldest = late[0]?.dueAt ? new Date(String(late[0].dueAt)) : undefined;
  return {
    overdue,
    oldestMinutes: oldest ? Math.round((now.getTime() - oldest.getTime()) / 60_000) : 0,
    sample: late.slice(0, 5).map((a) => ({
      actionId: String(a._id),
      personId: String(a.personId),
      minutesLate: Math.round((now.getTime() - new Date(String(a.dueAt)).getTime()) / 60_000),
    })),
  };
}
