import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * What worked.
 *
 * Two scopes, deliberately kept apart:
 *
 * Level 1 is per product — segment against angle, the thing a planner should read before
 * writing a sequence. It is aggregated straight off the actions, which already carry every
 * dimension the rollup needs. A parallel counters collection would only be a second copy
 * to drift from, and at these volumes the aggregation is a single index scan.
 *
 * Level 3 is global and shared across tenants. Timing, step count and channel mix are
 * mechanics that are true for everybody, so a brand-new product can inherit them on day
 * one instead of learning Tuesday-beats-Friday from scratch. It is stored rather than
 * aggregated because reading it must never mean reading across every tenant's actions,
 * and it deliberately carries no org, no angle, no segment and no person — those are the
 * customer's positioning, and sharing them would leak one company's research to another.
 */

export interface AngleRow {
  segment: string;
  angle: string;
  channel: string;
  sent: number;
  /** Sends that could report a click at all. A rate over anything else is a lie. */
  trackable: number;
  opened: number;
  clicked: number;
  replied: number;
  won: number;
  lost: number;
}

/**
 * Level 1. Only sends count: a message still queued has proved nothing, and one that
 * failed proves something about the channel rather than the angle.
 */
export async function anglePerformance(
  orgId: string,
  productId: string,
  segment?: string,
): Promise<AngleRow[]> {
  const db = await getDb();
  const match: Record<string, unknown> = {
    orgId,
    productId,
    status: { $in: ["sent", "dispatched"] },
    // Rehearsals reach a console, not a person. Counting them would mix messages nobody
    // could ever answer into the rates that decide what gets said next.
    dryRun: { $ne: true },
  };
  if (segment) match["variant.segment"] = segment;

  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            segment: { $ifNull: ["$variant.segment", "unclassified"] },
            angle: "$angle",
            channel: "$channel",
          },
          sent: { $sum: 1 },
          trackable: { $sum: { $cond: [{ $eq: ["$tracking.clicks", true] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ifNull: ["$firstOpenedAt", false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ifNull: ["$firstRepliedAt", false] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ["$goalOutcome", "won"] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$goalOutcome", "lost"] }, 1, 0] } },
        },
      },
      { $sort: { won: -1, clicked: -1, sent: -1 } },
    ])
    .toArray();

  return rows.map((r) => ({
    segment: String(r._id.segment),
    angle: String(r._id.angle),
    channel: String(r._id.channel),
    sent: r.sent,
    trackable: r.trackable,
    opened: r.opened,
    clicked: r.clicked,
    replied: r.replied,
    won: r.won,
    lost: r.lost,
  }));
}

export interface PriorRow {
  channel: string;
  stepIndex: number;
  hourLocal: number;
  sent: number;
  clicked: number;
  replied: number;
  won: number;
}

/** Level 3, read side. Mechanics only — nothing here identifies a tenant or a person. */
export async function timingPriors(limit = 60): Promise<PriorRow[]> {
  const db = await getDb();
  const rows = await db
    .collection(C.outcomePriors)
    .find({}, { projection: { _id: 0 } })
    .sort({ sent: -1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => ({
    channel: String(r.channel),
    stepIndex: Number(r.stepIndex ?? 0),
    hourLocal: Number(r.hourLocal ?? 0),
    sent: Number(r.sent ?? 0),
    clicked: Number(r.clicked ?? 0),
    replied: Number(r.replied ?? 0),
    won: Number(r.won ?? 0),
  }));
}

type PriorMetric = "sent" | "clicked" | "replied" | "won";

export interface PriorKey {
  channel?: unknown;
  variant?: { stepIndex?: unknown; hourLocal?: unknown };
}

/**
 * Level 3, write side.
 *
 * Silently does nothing for an action that predates the variant tag: without a step and an
 * hour there is no key, and a bucket of "unknown" would only dilute the real ones.
 */
export async function bumpPrior(action: PriorKey, metric: PriorMetric): Promise<void> {
  const stepIndex = action.variant?.stepIndex;
  const hourLocal = action.variant?.hourLocal;
  if (typeof stepIndex !== "number" || typeof hourLocal !== "number") return;

  const key = { channel: String(action.channel), stepIndex, hourLocal };
  const db = await getDb();
  await db
    .collection(C.outcomePriors)
    .updateOne(key, { $inc: { [metric]: 1 }, $setOnInsert: key }, { upsert: true });
}

/**
 * Ties a campaign's result back to the messages that produced it.
 *
 * Until this runs, a win has no cause: the goal instance knows it succeeded and the actions
 * know what they said, and nothing joins the two. Only sends are stamped — a message that
 * was skipped when the campaign ended did not contribute to the outcome either way.
 *
 * Guarded on the field being absent, so a campaign marked twice does not count twice.
 */
export async function stampGoalOutcome(
  orgId: string,
  goalInstanceId: string,
  outcome: "won" | "lost",
): Promise<number> {
  const db = await getDb();
  const filter = {
    orgId,
    goalInstanceId,
    status: { $in: ["sent", "dispatched"] },
    goalOutcome: { $exists: false },
  };

  const actions = await db
    .collection(C.actions)
    .find(filter, { projection: { channel: 1, variant: 1 } })
    .toArray();
  if (actions.length === 0) return 0;

  await db.collection(C.actions).updateMany(filter, { $set: { goalOutcome: outcome } });
  if (outcome === "won") {
    for (const a of actions) await bumpPrior(a as PriorKey, "won");
  }
  return actions.length;
}

/**
 * Ties a reply to the message it answers.
 *
 * The most recent send is the right guess and the only one available: a reply arrives as
 * an email in a mailbox, carrying no reference to the action that provoked it. Stamped
 * once, so a thread of five messages back and forth counts as one person answering rather
 * than five.
 */
export async function attributeReply(
  orgId: string,
  productId: string,
  personId: string,
  at: Date,
): Promise<string | null> {
  const db = await getDb();
  const action = await db.collection(C.actions).findOne(
    {
      orgId,
      productId,
      personId,
      status: { $in: ["sent", "dispatched"] },
      firstRepliedAt: { $exists: false },
    },
    { sort: { sentAt: -1 }, projection: { channel: 1, variant: 1 } },
  );
  if (!action) return null;

  await db
    .collection(C.actions)
    .updateOne(
      { _id: action._id },
      { $set: { firstRepliedAt: at }, $push: { signals: { type: "replied", at } } as never },
    );
  await bumpPrior(action as PriorKey, "replied");
  return String(action._id);
}

/** Called once per action id, from the click route. */
export async function bumpPriorForAction(actionId: string, metric: PriorMetric): Promise<void> {
  const db = await getDb();
  const action = await db
    .collection(C.actions)
    .findOne({ _id: new ObjectId(actionId) }, { projection: { channel: 1, variant: 1 } });
  if (action) await bumpPrior(action as PriorKey, metric);
}

/**
 * Below this, an angle has not failed — it has not been tried. Three sends and no reply is
 * a coin landing tails three times, and retiring an angle on that is how a product decides
 * its whole market on a sample of three.
 */
export const MIN_SAMPLE = 8;

/** How much of every new plan has to be spent on something not yet proven. */
export const EXPLORATION_FLOOR = 0.3;

/**
 * Keeps a planner from locking onto whatever won first.
 *
 * A model reading a table where one angle has two wins and the rest have none will use
 * that angle for every step — which is locally correct and globally fatal: the two other
 * angles never get the sends they need to prove themselves, so the table never changes,
 * so the same angle wins forever. The floor is enforced here rather than asked for in a
 * prompt for the same reason budgets are: a model that can argue past a guardrail
 * eventually will.
 *
 * It cannot deadlock. Any angle outside the proven set satisfies it, including a brand new
 * one, and a product with nothing proven yet is unconstrained.
 */
export async function explorationBlock(
  orgId: string,
  productId: string,
  segment: string | undefined,
  angles: string[],
): Promise<string | null> {
  if (angles.length === 0) return null;

  const distinct = new Set(angles);
  if (angles.length >= 3 && distinct.size === 1) {
    return `Every step of this plan uses the angle "${angles[0]}". A sequence that says the same thing four times tests one idea, not four — give the later steps different angles.`;
  }

  const rows = await anglePerformance(orgId, productId, segment);
  const proven = new Set(rows.filter((r) => r.sent >= MIN_SAMPLE && r.won > 0).map((r) => r.angle));
  if (proven.size === 0) return null;

  const required = Math.ceil(angles.length * EXPLORATION_FLOOR);
  const exploring = angles.filter((a) => !proven.has(a)).length;
  if (exploring >= required) return null;

  const short = required - exploring;
  return (
    `${required} of these ${angles.length} steps must use an angle that is not already proven, and ${exploring} ` +
    `${exploring === 1 ? "does" : "do"}. Proven here: ${[...proven].join(", ")}. Spending every step on those means ` +
    `the untested angles never get the sends they need to prove themselves, and what_works can never change. ` +
    `Replace ${short} ${short === 1 ? "step" : "steps"} with an untested or new angle.`
  );
}

export interface AngleTried {
  angle: string;
  sends: number;
  lastSentAt: Date | null;
  clicked: boolean;
  /** "won" or "lost" once the campaign it belonged to resolved; null while still running. */
  outcome: string | null;
}

/**
 * Every angle this person has already been shown, and how they answered.
 *
 * Derived from the actions rather than kept as a field on the person, for the same reason
 * the Level 1 rollup is: the data is already there under a different key, and a second
 * copy is only something to drift from.
 */
export async function anglesTriedOn(
  orgId: string,
  productId: string,
  personId: string,
): Promise<AngleTried[]> {
  const db = await getDb();
  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: { orgId, productId, personId, status: { $in: ["sent", "dispatched"] }, dryRun: { $ne: true } } },
      {
        $group: {
          _id: "$angle",
          sends: { $sum: 1 },
          lastSentAt: { $max: "$sentAt" },
          clicks: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ["$goalOutcome", "won"] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$goalOutcome", "lost"] }, 1, 0] } },
        },
      },
      { $sort: { lastSentAt: -1 } },
    ])
    .toArray();

  return rows.map((r) => ({
    angle: String(r._id),
    sends: r.sends,
    lastSentAt: r.lastSentAt ?? null,
    clicked: r.clicks > 0,
    outcome: r.won > 0 ? "won" : r.lost > 0 ? "lost" : null,
  }));
}

/**
 * Angles this person has already answered, by not answering.
 *
 * Two ways to have spent one: it was sent twice and ignored both times, or it was sent
 * inside a campaign that has since ended in failure. A click always rescues an angle — if
 * they clicked and still did not convert, the angle reached them and the ask was wrong, so
 * reusing it with a different call to action is exactly right.
 */
export function spentAngles(tried: AngleTried[]): Set<string> {
  return new Set(
    tried.filter((t) => !t.clicked && (t.sends >= 2 || t.outcome === "lost")).map((t) => t.angle),
  );
}

export interface PriorSummary {
  /** Hours of the recipient's day, best first. Only those with enough sends to mean anything. */
  bestHours: Array<{ hourLocal: number; sent: number; clickRate: number; replyRate: number; winRate: number }>;
  bestSteps: Array<{ stepIndex: number; sent: number; clickRate: number; replyRate: number; winRate: number }>;
  basedOn: number;
}

/**
 * The shared priors, reduced to the two things a planner can act on: when to send, and how
 * far into a sequence the returns actually are.
 *
 * These are mechanics, true across products, which is why they can be shared at all —
 * nothing here says who sent what to whom, or about what.
 */
export async function summarisePriors(): Promise<PriorSummary> {
  const db = await getDb();
  const rows = await db.collection(C.outcomePriors).find({}, { projection: { _id: 0 } }).toArray();

  const byHour = new Map<number, { sent: number; clicked: number; replied: number; won: number }>();
  const byStep = new Map<number, { sent: number; clicked: number; replied: number; won: number }>();
  let total = 0;

  for (const r of rows) {
    const sent = Number(r.sent ?? 0);
    const clicked = Number(r.clicked ?? 0);
    const replied = Number(r.replied ?? 0);
    const won = Number(r.won ?? 0);
    total += sent;
    for (const [map, key] of [
      [byHour, Number(r.hourLocal ?? 0)],
      [byStep, Number(r.stepIndex ?? 0)],
    ] as const) {
      const cur = map.get(key) ?? { sent: 0, clicked: 0, replied: 0, won: 0 };
      map.set(key, {
        sent: cur.sent + sent,
        clicked: cur.clicked + clicked,
        replied: cur.replied + replied,
        won: cur.won + won,
      });
    }
  }

  // A bucket under the minimum sample is noise wearing a percentage sign. One send that
  // happened to convert would otherwise present itself as a 100% hour.
  const rank = <K extends string>(
    map: Map<number, { sent: number; clicked: number; replied: number; won: number }>,
    key: K,
  ) =>
    [...map.entries()]
      .filter(([, v]) => v.sent >= MIN_SAMPLE)
      .map(([k, v]) => ({
        [key]: k,
        sent: v.sent,
        clickRate: Number((v.clicked / v.sent).toFixed(3)),
        replyRate: Number((v.replied / v.sent).toFixed(3)),
        winRate: Number((v.won / v.sent).toFixed(3)),
      }))
      .sort((a, b) => b.winRate - a.winRate || b.clickRate - a.clickRate)
      .slice(0, 8);

  return {
    bestHours: rank(byHour, "hourLocal") as PriorSummary["bestHours"],
    bestSteps: rank(byStep, "stepIndex") as PriorSummary["bestSteps"],
    basedOn: total,
  };
}
