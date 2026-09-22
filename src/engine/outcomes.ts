import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { creditAssets } from "./assets.js";

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

export interface ThemeRow {
  group: string;
  theme: string;
  angle: string;
  hook: string | null;
  format: string | null;
  ask: string | null;
  layout: string | null;
  channel: string;
  sent: number;
  trackable: number;
  opened: number;
  clicked: number;
  replied: number;
  won: number;
  lastSentAt: Date | null;
}

/**
 * What the rolling planner has learned, cut the way it decides.
 *
 * The idea, how it was delivered, the format, the ask and the channel, within a group of
 * similar leads (segment and team size band). Only messages that carried a theme are here:
 * everything sent before the rolling planner has no theme and is already in the angle table.
 *
 * `group` narrows to one group. Omitted, every group comes back and the reader can see a
 * theme that works for small teams and fails for large ones as the two rows it is.
 */
export async function themePerformance(orgId: string, productId: string, group?: string): Promise<ThemeRow[]> {
  const db = await getDb();
  const match: Record<string, unknown> = {
    orgId,
    productId,
    status: { $in: ["sent", "dispatched"] },
    dryRun: { $ne: true },
    "variant.theme": { $type: "string" },
  };
  if (group) match["variant.group"] = group;

  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            group: { $ifNull: ["$variant.group", "unknown"] },
            angle: "$angle",
            hook: { $ifNull: ["$variant.hook", null] },
            format: { $ifNull: ["$variant.format", null] },
            ask: { $ifNull: ["$variant.ask", null] },
            layout: { $ifNull: ["$variant.layout", null] },
            channel: "$channel",
          },
          theme: { $last: "$variant.theme" },
          sent: { $sum: 1 },
          trackable: { $sum: { $cond: [{ $eq: ["$tracking.clicks", true] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ifNull: ["$firstOpenedAt", false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ifNull: ["$firstRepliedAt", false] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ["$goalOutcome", "won"] }, 1, 0] } },
          lastSentAt: { $max: "$sentAt" },
        },
      },
      { $sort: { won: -1, replied: -1, clicked: -1, sent: -1 } },
      { $limit: 300 },
    ])
    .toArray();

  return rows.map((r) => ({
    group: String(r._id.group),
    theme: String(r.theme ?? r._id.angle),
    angle: String(r._id.angle),
    hook: r._id.hook ? String(r._id.hook) : null,
    format: r._id.format ? String(r._id.format) : null,
    ask: r._id.ask ? String(r._id.ask) : null,
    layout: r._id.layout ? String(r._id.layout) : null,
    channel: String(r._id.channel),
    sent: r.sent,
    trackable: r.trackable,
    opened: r.opened,
    clicked: r.clicked,
    replied: r.replied,
    won: r.won,
    lastSentAt: r.lastSentAt ?? null,
  }));
}

export interface IdeaRow {
  n: number;
  group: string;
  sent: number;
  trackable: number;
  opened: number;
  clicked: number;
  replied: number;
  won: number;
  lastSentAt: Date | null;
}

/**
 * What each idea has earned, per group of similar leads.
 *
 * The theme table reads the words a planner put on a touch, and two leads given the same idea
 * get two different themes, so the idea itself never had a record. Every written touch now
 * carries the numbers of the ideas it was built on; this counts the sends behind each number.
 */
export async function ideaPerformance(orgId: string, productId: string): Promise<IdeaRow[]> {
  const db = await getDb();
  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: { orgId, productId, status: { $in: ["sent", "dispatched"] }, dryRun: { $ne: true }, "ideaRefs.0": { $exists: true } } },
      { $unwind: "$ideaRefs" },
      {
        $group: {
          _id: { n: "$ideaRefs", group: { $ifNull: ["$variant.group", "unknown"] } },
          sent: { $sum: 1 },
          trackable: { $sum: { $cond: [{ $eq: ["$tracking.clicks", true] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ifNull: ["$firstOpenedAt", false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ifNull: ["$firstRepliedAt", false] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ["$goalOutcome", "won"] }, 1, 0] } },
          lastSentAt: { $max: "$sentAt" },
        },
      },
    ])
    .toArray();
  return rows.map((r) => ({
    n: Number(r._id.n),
    group: String(r._id.group),
    sent: r.sent,
    trackable: r.trackable,
    opened: r.opened,
    clicked: r.clicked,
    replied: r.replied,
    won: r.won,
    lastSentAt: r.lastSentAt ?? null,
  }));
}

/** How much a row can be trusted, in the words the learning notes use. */
export function evidenceStatus(row: { sent: number; clicked: number; replied: number }): "guess" | "promising" | "confirmed" | "retire" {
  const responses = row.clicked + row.replied;
  if (row.sent < 5) return "guess";
  if (row.sent >= 10 && responses >= 2) return "confirmed";
  if (row.sent >= 10 && responses === 0) return "retire";
  return responses > 0 ? "promising" : "guess";
}

export interface AssetRow {
  angle: string;
  /** The asset's key, or null for the sends of that angle that carried nothing. */
  assetKey: string | null;
  tier: string | null;
  sent: number;
  trackable: number;
  clicked: number;
  replied: number;
  won: number;
}

/**
 * The same record as `anglePerformance`, cut by what each message carried.
 *
 * This is the only question the rollup could not answer before: an angle sent with a demo
 * video and the same angle sent as words alone were one row, so the video was credited to
 * the argument and the argument was blamed for the video. Both rows are returned — the
 * one that carried something and the one that did not — because the comparison is the
 * whole point and a table of only the carried sends says nothing.
 *
 * Sends made before assets existed carry no `assetKey` and land in the null row, which is
 * correct: they carried nothing.
 */
export async function assetPerformance(
  orgId: string,
  productId: string,
  segment?: string,
): Promise<AssetRow[]> {
  const db = await getDb();
  const match: Record<string, unknown> = {
    orgId,
    productId,
    status: { $in: ["sent", "dispatched"] },
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
            angle: "$angle",
            // A message carrying two assets is deliberately its own bucket rather than
            // being counted under each: what it proved is that the pair worked, and
            // splitting it would claim evidence for each half that nobody gathered.
            assetKey: { $ifNull: ["$variant.assetKey", null] },
            tier: { $ifNull: ["$variant.assetTier", null] },
          },
          sent: { $sum: 1 },
          trackable: { $sum: { $cond: [{ $eq: ["$tracking.clicks", true] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ifNull: ["$firstRepliedAt", false] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ["$goalOutcome", "won"] }, 1, 0] } },
        },
      },
      { $sort: { won: -1, clicked: -1, sent: -1 } },
    ])
    .toArray();

  return rows.map((r) => ({
    angle: String(r._id.angle),
    assetKey: r._id.assetKey === null || r._id.assetKey === undefined ? null : String(r._id.assetKey),
    tier: r._id.tier === null || r._id.tier === undefined ? null : String(r._id.tier),
    sent: r.sent,
    trackable: r.trackable,
    clicked: r.clicked,
    replied: r.replied,
    won: r.won,
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
    .find(filter, { projection: { channel: 1, variant: 1, productId: 1, assetIds: 1 } })
    .toArray();
  if (actions.length === 0) return 0;

  await db.collection(C.actions).updateMany(filter, { $set: { goalOutcome: outcome } });
  if (outcome === "won") {
    for (const a of actions) await bumpPrior(a as PriorKey, "won");

    // An asset is credited once for the campaign it helped win, not once per message it
    // rode on. Sending the same case study twice cannot make it look twice as persuasive —
    // the filter above already refuses to stamp a campaign a second time, and this dedupes
    // within it.
    const wonWith = new Set(actions.flatMap((a) => ((a.assetIds ?? []) as unknown[]).map(String)));
    const productId = actions.find((a) => a.productId)?.productId;
    if (wonWith.size > 0 && productId) {
      await creditAssets(orgId, String(productId), [...wonWith], "ledToGoal");
    }
  }
  return actions.length;
}

/**
 * Ties a reply to the message it answers.
 *
 * The inbound pollers already know that message — the email in the same thread, the
 * WhatsApp send the chat shows just before theirs — and pass it as `answeredId`. Without
 * it, the most recent send before the reply is the guess. Before the reply, not before
 * now: a WhatsApp answered on Monday and read by a routine on Tuesday was credited to
 * Tuesday morning's email, and the answer went out by email to a WhatsApp message.
 *
 * Stamped once, so a thread of five messages back and forth counts as one person
 * answering rather than five. The known send is returned even when it was stamped
 * already, because the answer still belongs in its conversation.
 */
export async function attributeReply(
  orgId: string,
  productId: string,
  personId: string,
  at: Date,
  answeredId?: string,
): Promise<string | null> {
  const db = await getDb();
  const projection = { channel: 1, variant: 1, firstRepliedAt: 1 };
  const action =
    (answeredId && ObjectId.isValid(answeredId)
      ? await db
          .collection(C.actions)
          .findOne({ _id: new ObjectId(answeredId), orgId, productId, personId, status: { $in: ["sent", "dispatched"] } }, { projection })
      : null) ??
    (await db.collection(C.actions).findOne(
      {
        orgId,
        productId,
        personId,
        status: { $in: ["sent", "dispatched"] },
        sentAt: { $lte: at },
        firstRepliedAt: { $exists: false },
      },
      { sort: { sentAt: -1 }, projection },
    ));
  if (!action) return null;
  if (action.firstRepliedAt) return String(action._id);

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
