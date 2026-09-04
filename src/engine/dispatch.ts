import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { PRIORITY, THINKING_KINDS, type ThinkingKind } from "./queue.js";

/**
 * Who gets worked on next, decided every minute, by arithmetic.
 *
 * The routines that do the thinking can only run once an hour, and each one can only get
 * through a bounded slice. Something has to choose that slice, and for a long time nothing
 * did: `sweep` read the first two hundred goal instances in natural order and filtered them
 * afterwards, so a product whose first two hundred rows happened to be finished reported
 * "nothing to do" while thousands waited behind them. The failure was silent, which is what
 * made it expensive.
 *
 * Choosing is not judgment. It is a fixed budget divided across tenants, which is a
 * scheduling problem with a known answer: deficit round robin (Shreedhar and Varghese,
 * 1995), the algorithm routers use to stop one flow starving the others. Each campaign gets
 * a quantum per round, spends down to its backlog, and carries what it did not use. A
 * campaign of twelve finishes quickly and hands its remainder back; a campaign of ten
 * thousand cannot monopolise the lane.
 *
 * No model is involved, so this runs on the minute clock rather than the hourly one, and
 * the hourly routines find their work already chosen and already fair.
 */

/** How many items one campaign may be granted in a single round, per kind. */
const QUANTUM: Record<ThinkingKind, number> = {
  // Classification is the cheapest per person and the one with the largest backlog, so it
  // gets the widest quantum: a session batches a hundred of these into one call.
  classify: 60,
  // A playbook is written once per segment and then read by everyone in it. Rare, and
  // nothing downstream can be good until it exists.
  playbook: 5,
  compose: 12,
  // Escalations are priority 0 and bypass the round entirely; the quantum only bounds the
  // rare case of a flood, where spending the whole hour on one campaign's clicks would
  // starve every other campaign's.
  escalate: 10,
  monitor: 25,
  groom: 2,
};

/**
 * The ceiling on how much work may sit ready at once, per kind.
 *
 * Marking more ready than an hourly routine can finish is not free: the surplus sits
 * leased-and-abandoned, ages, and reads as a backlog the routine is ignoring. The number is
 * roughly what one session gets through, so "ready" means "someone is about to do this".
 */
const READY_CEILING: Record<ThinkingKind, number> = {
  classify: 800,
  playbook: 20,
  compose: 120,
  escalate: 100,
  monitor: 200,
  groom: 10,
};

export interface LaneReport {
  kind: ThinkingKind;
  urgent: number;
  granted: number;
  /** Campaigns that wanted work this round and got none. */
  starved: Array<{ productId: string; campaignKey: string; waiting: number; oldestMinutes: number }>;
}

export interface DispatchSummary {
  orgId: string;
  lanes: LaneReport[];
}

interface Bucket {
  productId: string;
  campaignKey: string;
  waiting: number;
  oldest: Date;
}

/**
 * The deficit counters, held in the database rather than in memory.
 *
 * The tick is a stateless request that may run on any instance, so a counter kept in a
 * process would reset at deploy time and silently favour whichever campaign the fresh
 * process happened to see first. One small document per org per kind survives that.
 */
interface LaneState {
  deficits: Record<string, number>;
  /** Where the next cycle starts its rotation, so the leftover never lands on one campaign. */
  cursor: number;
}

async function readState(orgId: string, kind: ThinkingKind): Promise<LaneState> {
  const db = await getDb();
  const row = await db.collection(C.audit).findOne({ orgId, kind, type: "dispatch_deficit" });
  return {
    deficits: (row?.deficits ?? {}) as Record<string, number>,
    cursor: Number(row?.cursor ?? 0),
  };
}

async function writeState(orgId: string, kind: ThinkingKind, state: LaneState): Promise<void> {
  const db = await getDb();
  await db.collection(C.audit).updateOne(
    { orgId, kind, type: "dispatch_deficit" },
    { $set: { deficits: state.deficits, cursor: state.cursor, updatedAt: new Date() } },
    { upsert: true },
  );
}

/**
 * One lane: serve the urgent in full, then divide what is left fairly.
 *
 * Urgency is not negotiable and is deliberately outside the fair share. A reply or a click
 * is the event the whole system exists to catch, and making one wait behind a routine
 * classification of somebody who has done nothing is the one queue behaviour that cannot be
 * defended. Everything else queues.
 */
async function dispatchLane(orgId: string, kind: ThinkingKind, now: Date): Promise<LaneReport> {
  const db = await getDb();

  const alreadyReady = await db
    .collection(C.workQueue)
    .countDocuments({ orgId, kind, status: { $in: ["ready", "running"] } });
  let budget = Math.max(0, READY_CEILING[kind] - alreadyReady);

  const report: LaneReport = { kind, urgent: 0, granted: 0, starved: [] };
  if (budget === 0) return report;

  // Urgent work first, ignoring the round entirely.
  const urgent = await db
    .collection(C.workQueue)
    .find({ orgId, kind, status: "queued", priority: PRIORITY.urgent, dueAt: { $lte: now } })
    .sort({ dueAt: 1 })
    .limit(budget)
    .project({ _id: 1 })
    .toArray();

  if (urgent.length) {
    await db
      .collection(C.workQueue)
      .updateMany({ _id: { $in: urgent.map((u) => u._id) } }, { $set: { status: "ready" } });
    report.urgent = urgent.length;
    report.granted += urgent.length;
    budget -= urgent.length;
  }
  if (budget === 0) return report;

  // What each campaign is waiting on. Grouped rather than listed: the whole point is to
  // divide a budget across tenants without reading ten thousand rows to do it.
  const buckets = (await db
    .collection(C.workQueue)
    .aggregate([
      { $match: { orgId, kind, status: "queued", priority: { $ne: PRIORITY.urgent }, dueAt: { $lte: now } } },
      {
        $group: {
          _id: { productId: "$productId", campaignKey: "$campaignKey" },
          waiting: { $sum: 1 },
          oldest: { $min: "$dueAt" },
        },
      },
    ])
    .toArray()) as Array<{ _id: { productId?: string; campaignKey?: string }; waiting: number; oldest: Date }>;

  if (buckets.length === 0) return report;

  const queues: Bucket[] = buckets
    .map((b) => ({
      productId: String(b._id.productId ?? "unassigned"),
      campaignKey: String(b._id.campaignKey ?? "unassigned"),
      waiting: b.waiting,
      oldest: b.oldest ?? now,
    }))
    // Sorted so the rotation below means something. An aggregation returns groups in no
    // guaranteed order, and rotating by an index into an unordered list moves the starting
    // point to a different campaign each cycle at random — which looks like rotation and is
    // not, because the same campaign can land at the front twice running.
    .sort((a, b) => `${a.productId}:${a.campaignKey}`.localeCompare(`${b.productId}:${b.campaignKey}`));

  const state = await readState(orgId, kind);
  const deficits = state.deficits;
  const keyOf = (q: Bucket) => `${q.productId}:${q.campaignKey}`;
  const grants = new Map<string, number>();

  // Rotated so the leftover does not land on the same campaigns every cycle.
  //
  // A budget of eight hundred across ten campaigns is six hundred in the first round and two
  // hundred spare, and the spare goes to whoever the loop reaches first. Walking the list
  // from the top each time meant the first few campaigns took a second helping every single
  // minute while the last few never did — fair within a round and unfair over an hour, which
  // is the timescale anybody actually cares about.
  const start = queues.length ? state.cursor % queues.length : 0;
  const order = [...queues.slice(start), ...queues.slice(0, start)];

  // A campaign keeps the credit it could not spend, so the round after a starved one is the
  // round it catches up in. Rounds continue while budget and demand both remain, which lets
  // one campaign take a second helping only once every other has taken its first.
  let rounds = 0;
  // How many campaigns took a share of the surplus — the helpings handed out after every
  // queue has had its first. That count, not the number served overall, is what the cursor
  // advances by: rotating past everybody would land back where it started and rotate nothing.
  let surplusServed = 0;
  while (budget > 0 && rounds < 20) {
    let spentThisRound = 0;
    for (const q of order) {
      const key = keyOf(q);
      const granted = grants.get(key) ?? 0;
      const outstanding = q.waiting - granted;

      if (budget === 0) {
        // The budget ran out before this campaign's turn came round. Its quantum is banked
        // rather than forgotten, so it leads the next cycle — this is the whole difference
        // between a queue that is briefly behind and one that is permanently behind.
        if (outstanding > 0) deficits[key] = (deficits[key] ?? 0) + QUANTUM[kind];
        continue;
      }

      if (outstanding <= 0) {
        // Nothing left to give this campaign: its unspent credit is dropped rather than
        // hoarded, so a finished campaign cannot bank a quantum every minute and then swamp
        // the lane on the day it next has work.
        deficits[key] = 0;
        continue;
      }

      const credit = (deficits[key] ?? 0) + QUANTUM[kind];
      const take = Math.min(credit, outstanding, budget);
      if (take <= 0) continue;

      grants.set(key, granted + take);
      deficits[key] = credit - take;
      budget -= take;
      spentThisRound += take;
      if (rounds > 0) surplusServed++;
    }
    if (spentThisRound === 0) break;
    rounds++;
  }

  // Next cycle picks up where this one stopped handing out the surplus.
  state.cursor = queues.length ? (start + Math.max(surplusServed, 1)) % queues.length : 0;

  // Grant per campaign, oldest first inside each. Filtering before limiting, which is the
  // half of this that the old sweep got backwards.
  for (const q of queues) {
    const take = grants.get(keyOf(q)) ?? 0;
    if (take === 0) {
      report.starved.push({
        productId: q.productId,
        campaignKey: q.campaignKey,
        waiting: q.waiting,
        oldestMinutes: Math.round((now.getTime() - new Date(q.oldest).getTime()) / 60_000),
      });
      continue;
    }

    const chosen = await db
      .collection(C.workQueue)
      .find({
        orgId,
        kind,
        status: "queued",
        priority: { $ne: PRIORITY.urgent },
        dueAt: { $lte: now },
        productId: q.productId === "unassigned" ? { $exists: false } : q.productId,
        campaignKey: q.campaignKey === "unassigned" ? { $exists: false } : q.campaignKey,
      })
      .sort({ dueAt: 1 })
      .limit(take)
      .project({ _id: 1 })
      .toArray();

    if (chosen.length === 0) continue;
    await db
      .collection(C.workQueue)
      .updateMany({ _id: { $in: chosen.map((c) => c._id) } }, { $set: { status: "ready" } });
    report.granted += chosen.length;
  }

  await writeState(orgId, kind, state);
  return report;
}

/**
 * Runs every lane for one org.
 *
 * Cheap by construction: one grouped count per lane plus one update per campaign that was
 * granted anything. It reads no people, no plans and no message bodies, so its cost does
 * not move when the org grows from one thousand leads to one hundred thousand.
 */
export async function dispatch(orgId: string, now = new Date()): Promise<DispatchSummary> {
  const lanes: LaneReport[] = [];
  for (const kind of THINKING_KINDS) {
    lanes.push(await dispatchLane(orgId, kind, now));
  }
  return { orgId, lanes };
}

export interface BacklogRow {
  productId: string;
  campaignKey: string;
  kind: string;
  waiting: number;
  ready: number;
  oldestMinutes: number;
}

/**
 * What is waiting, per campaign, for anyone reading the console.
 *
 * A backlog that exists only as an absence of activity is indistinguishable from an empty
 * one, and that is precisely how this system hid nine thousand unplanned people behind a
 * routine that cheerfully reported "nothing to do".
 */
export async function backlog(orgId: string, now = new Date()): Promise<BacklogRow[]> {
  const db = await getDb();
  const rows = (await db
    .collection(C.workQueue)
    .aggregate([
      { $match: { orgId, status: { $in: ["queued", "ready", "running"] } } },
      {
        $group: {
          _id: { productId: "$productId", campaignKey: "$campaignKey", kind: "$kind" },
          waiting: { $sum: { $cond: [{ $eq: ["$status", "queued"] }, 1, 0] } },
          ready: { $sum: { $cond: [{ $eq: ["$status", "queued"] }, 0, 1] } },
          oldest: { $min: "$dueAt" },
        },
      },
      { $sort: { waiting: -1 } },
      { $limit: 200 },
    ])
    .toArray()) as Array<{
    _id: { productId?: string; campaignKey?: string; kind: string };
    waiting: number;
    ready: number;
    oldest: Date;
  }>;

  return rows.map((r) => ({
    productId: String(r._id.productId ?? "unassigned"),
    campaignKey: String(r._id.campaignKey ?? "unassigned"),
    kind: String(r._id.kind),
    waiting: r.waiting,
    ready: r.ready,
    oldestMinutes: Math.round((now.getTime() - new Date(r.oldest ?? now).getTime()) / 60_000),
  }));
}
