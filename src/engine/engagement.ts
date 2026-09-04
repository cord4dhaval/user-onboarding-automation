import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { signalField } from "./tracking.js";

/**
 * What people did back.
 *
 * Everything else in the engine measures what we did — messages composed, sent, spent.
 * A click was written to the action that earned it and read by nothing, so a campaign
 * could have nine interested readers and report itself as silence. This is the read side
 * of that record: per campaign for the list, per person for the library, and one person's
 * full detail for their own page.
 *
 * The signal lives on the action rather than in the events collection, because the
 * question is always "which message did they respond to" and an event with a person and
 * no message cannot answer it. Replies are the exception — mail arrives against a mailbox,
 * not against a message — so they are counted from events and attributed to the person.
 */

/**
 * Only a message that actually went out can be responded to.
 *
 * A tracking link in a draft can still be reached — a preview, a test run, a link someone
 * pasted on — and counting that as engagement credits a send that never happened. Those
 * hits are counted separately and named, never folded into the rate.
 */
const DELIVERED = ["sent", "dispatched"];

export interface Engagement {
  /** Messages the provider accepted. Queued and held ones are not sends. */
  sent: number;
  /** Sends whose links were wrapped — the only honest denominator for a click rate. */
  trackable: number;
  /**
   * Sends that carried a pixel. Usually zero: a pixel needs opt-in consent, and most leads
   * arrive under legitimate interest. Zero here means opens were never measured, which is
   * a different sentence from nobody having opened, and the console must not merge them.
   */
  openTrackable: number;
  opened: number;
  clicked: number;
  /** Clicks that were a security gateway scanning the mail. Reported, never counted in. */
  machineClicked: number;
  /** People who wrote back, not messages: one reply answers a thread, not a send. */
  replied: number;
  unsubscribed: number;
  bounced: number;
  failed: number;
  /** Links reached in a message that was never sent. Almost always our own testing. */
  preSend: number;
}

const empty = (): Engagement => ({
  sent: 0,
  trackable: 0,
  openTrackable: 0,
  opened: 0,
  clicked: 0,
  machineClicked: 0,
  replied: 0,
  unsubscribed: 0,
  bounced: 0,
  failed: 0,
  preSend: 0,
});

/** A rate nobody can be misled by: no denominator, no number. */
export function rate(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Engagement for every campaign in one product, keyed by goal key.
 *
 * Actions carry the campaign run they belong to rather than the campaign itself, so the
 * run is resolved here instead of denormalising a key onto several hundred thousand
 * actions. The conversion is guarded: an action written before goalInstanceId existed
 * would otherwise abort the whole pipeline rather than sit out of one row.
 */
export async function campaignEngagement(
  orgId: string,
  productId: string,
): Promise<Map<string, Engagement>> {
  const db = await getDb();
  const out = new Map<string, Engagement>();
  const of = (key: string) => {
    const existing = out.get(key);
    if (existing) return existing;
    const fresh = empty();
    out.set(key, fresh);
    return fresh;
  };

  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: { orgId, productId } },
      { $addFields: { runId: { $convert: { input: "$goalInstanceId", to: "objectId", onError: null, onNull: null } } } },
      { $match: { runId: { $ne: null } } },
      {
        $lookup: {
          from: C.goalInstances,
          localField: "runId",
          foreignField: "_id",
          pipeline: [{ $project: { goalKey: 1 } }],
          as: "run",
        },
      },
      { $addFields: { goalKey: { $arrayElemAt: ["$run.goalKey", 0] } } },
      { $match: { goalKey: { $ne: null } } },
      {
        $group: {
          _id: "$goalKey",
          sent: { $sum: { $cond: [{ $in: ["$status", DELIVERED] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          trackable: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", DELIVERED] },
                    { $ne: [{ $ifNull: ["$tracking.clicks", false] }, false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          // Zero here is the difference between "nobody opened" and "we never asked". A
          // pixel needs opt-in consent, so on most products this stays at nought and the
          // open column has to say so rather than printing a measurement it never made.
          openTrackable: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", DELIVERED] },
                    { $ne: [{ $ifNull: ["$tracking.opens", false] }, false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          machineClicked: {
            $sum: {
              $cond: [
                { $and: [{ $in: ["$status", DELIVERED] }, { $ifNull: ["$firstMachineClickedAt", false] }] },
                1,
                0,
              ],
            },
          },
          opened: {
            $sum: {
              $cond: [
                { $and: [{ $in: ["$status", DELIVERED] }, { $ifNull: ["$firstOpenedAt", false] }] },
                1,
                0,
              ],
            },
          },
          clicked: {
            $sum: {
              $cond: [
                { $and: [{ $in: ["$status", DELIVERED] }, { $ifNull: ["$firstClickedAt", false] }] },
                1,
                0,
              ],
            },
          },
          preSend: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $not: [{ $in: ["$status", DELIVERED] }] },
                    { $ifNull: ["$firstClickedAt", false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ])
    .toArray();

  for (const row of rows) {
    Object.assign(of(String(row._id)), {
      sent: Number(row.sent ?? 0),
      trackable: Number(row.trackable ?? 0),
      openTrackable: Number(row.openTrackable ?? 0),
      opened: Number(row.opened ?? 0),
      clicked: Number(row.clicked ?? 0),
      machineClicked: Number(row.machineClicked ?? 0),
    });
    of(String(row._id)).failed = Number(row.failed ?? 0);
    of(String(row._id)).preSend = Number(row.preSend ?? 0);
  }

  // Replies, unsubscribes and bounces reach us against a person, never against the message
  // that provoked them. Attributing one to every campaign that person was in would double
  // count them; attributing to none would hide the strongest signal the system gets. So it
  // is counted as "people in this campaign who did X", which is the sentence a reader
  // would say out loud anyway.
  for (const [type, field] of [
    ["reply_received", "replied"],
    ["unsubscribed", "unsubscribed"],
    ["bounce_received", "bounced"],
  ] as const) {
    const people = (await db.collection(C.events).distinct("personId", { orgId, productId, type })).map(String);
    if (people.length === 0) continue;
    const perGoal = await db
      .collection(C.goalInstances)
      .aggregate([
        { $match: { orgId, productId, personId: { $in: people } } },
        { $group: { _id: "$goalKey", people: { $addToSet: "$personId" } } },
      ])
      .toArray();
    for (const row of perGoal) of(String(row._id))[field] = (row.people as unknown[]).length;
  }

  return out;
}

export interface PersonEngagement {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  lastOpenedAt?: Date;
  lastClickedAt?: Date;
  lastRepliedAt?: Date;
}

/**
 * The same read for a page of people, in two queries rather than two per row. The library
 * lists a hundred at a time, and a per-row lookup there is a hundred round trips to render
 * one column.
 */
export async function peopleEngagement(
  orgId: string,
  productId: string,
  personIds: string[],
): Promise<Map<string, PersonEngagement>> {
  const out = new Map<string, PersonEngagement>();
  if (personIds.length === 0) return out;

  const db = await getDb();
  const of = (id: string) => {
    const existing = out.get(id);
    if (existing) return existing;
    const fresh: PersonEngagement = { sent: 0, opened: 0, clicked: 0, replied: 0 };
    out.set(id, fresh);
    return fresh;
  };

  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: { orgId, productId, personId: { $in: personIds }, status: { $in: DELIVERED } } },
      {
        $group: {
          _id: "$personId",
          sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "dispatched"]] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $ifNull: ["$firstOpenedAt", false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          lastOpenedAt: { $max: "$firstOpenedAt" },
          lastClickedAt: { $max: "$firstClickedAt" },
        },
      },
    ])
    .toArray();

  for (const row of rows) {
    Object.assign(of(String(row._id)), {
      sent: Number(row.sent ?? 0),
      opened: Number(row.opened ?? 0),
      clicked: Number(row.clicked ?? 0),
      lastOpenedAt: row.lastOpenedAt ? new Date(String(row.lastOpenedAt)) : undefined,
      lastClickedAt: row.lastClickedAt ? new Date(String(row.lastClickedAt)) : undefined,
    });
  }

  const replies = await db
    .collection(C.events)
    .aggregate([
      { $match: { orgId, productId, type: "reply_received", personId: { $in: personIds } } },
      { $group: { _id: "$personId", n: { $sum: 1 }, last: { $max: "$ts" } } },
    ])
    .toArray();

  for (const row of replies) {
    const person = of(String(row._id));
    person.replied = Number(row.n ?? 0);
    person.lastRepliedAt = row.last ? new Date(String(row.last)) : undefined;
  }

  return out;
}

/** People this product has ever heard back from, for the library's engagement filter. */
export type EngagementState = "opened" | "clicked" | "replied" | "none";

export async function peopleMatching(
  orgId: string,
  productId: string,
  state: Exclude<EngagementState, "none">,
): Promise<string[]> {
  const db = await getDb();
  if (state === "replied") {
    return (
      await db.collection(C.events).distinct("personId", { orgId, productId, type: "reply_received" })
    ).map(String);
  }
  const field = state === "opened" ? "firstOpenedAt" : "firstClickedAt";
  return (
    await db
      .collection(C.actions)
      .distinct("personId", { orgId, productId, status: { $in: DELIVERED }, [field]: { $exists: true } })
  ).map(String);
}

/**
 * Everything one person did, message by message, for their own page.
 *
 * Each signal is returned separately rather than folded into a count, because "opened
 * twice, then clicked an hour later" is a different story from "opened twice" and the page
 * exists to tell the story.
 */
export interface Signal {
  type: "opened" | "clicked";
  at: Date;
  /** Where a click went. Only recorded from the point the link carried it. */
  url?: string;
  /** A security gateway scanning the message, not a person reading it. */
  bot?: boolean;
  actionId: string;
  subject?: string;
}

export function signalsOf(actions: Document[]): Signal[] {
  const out: Signal[] = [];
  for (const action of actions) {
    const subject = (action.content as { subject?: string } | undefined)?.subject;
    const recorded = (action.signals ?? []) as Array<{
      type?: string;
      at?: unknown;
      url?: unknown;
      bot?: unknown;
    }>;
    const seen = new Set<string>();

    for (const signal of recorded) {
      if (signal.type !== "opened" && signal.type !== "clicked") continue;
      if (!signal.at) continue;
      // Only a human signal satisfies the fallback below: a message whose sole record is a
      // scanner fetch must still fall through to its own first-touch stamp if it has one.
      if (!signal.bot) seen.add(signal.type);
      out.push({
        type: signal.type,
        at: new Date(String(signal.at)),
        url: signal.url ? String(signal.url) : undefined,
        bot: Boolean(signal.bot),
        actionId: String(action._id),
        subject,
      });
    }

    // A message tracked before signals were kept as a list still has its first-touch
    // stamps. Dropping those would make old engagement vanish from the timeline the day
    // the richer record was introduced.
    if (!seen.has("opened") && action.firstOpenedAt) {
      out.push({ type: "opened", at: new Date(String(action.firstOpenedAt)), actionId: String(action._id), subject });
    }
    if (!seen.has("clicked") && action.firstClickedAt) {
      out.push({ type: "clicked", at: new Date(String(action.firstClickedAt)), actionId: String(action._id), subject });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Guards a person id that came in from a URL before it reaches a query. */
export const isId = (value: string): boolean => ObjectId.isValid(value);

/**
 * Moves a signal already recorded as a person's into the machine column.
 *
 * Used by the backfill for signals collected before machines were told apart, and by the
 * unsubscribe page when a scanner reveals itself by walking that link too. The shared
 * counter is wound back with it: a prior that learned "this hour gets clicks" from a
 * gateway would go on recommending that hour to every product on the platform.
 */
export async function demoteToMachine(
  actionId: string | ObjectId,
  type: "opened" | "clicked",
): Promise<boolean> {
  const db = await getDb();
  const _id = typeof actionId === "string" ? new ObjectId(actionId) : actionId;
  const human = signalField(type, false);
  const machine = signalField(type, true);

  const action = await db.collection(C.actions).findOne({ _id }, { projection: { [human]: 1, signals: 1, channel: 1, variant: 1 } });
  const at = action?.[human] as Date | undefined;
  if (!at) return false;

  const signals = ((action?.signals ?? []) as Array<Record<string, unknown>>).map((signal) =>
    signal.type === type && !signal.bot && sameInstant(signal.at, at) ? { ...signal, bot: true } : signal,
  );

  await db.collection(C.actions).updateOne(
    { _id },
    {
      // The machine field is only filled if it is empty: an action that already has a
      // scanner signal of this kind keeps the earlier one, which is the one that dates the
      // scan.
      $set: { signals, ...(action?.[machine] ? {} : { [machine]: at }) },
      $unset: { [human]: "" },
    },
  );

  if (type === "clicked") {
    const variant = (action?.variant ?? {}) as { stepIndex?: number; hourLocal?: number };
    if (typeof variant.stepIndex === "number" && typeof variant.hourLocal === "number") {
      await db
        .collection(C.outcomePriors)
        .updateOne(
          { channel: String(action?.channel), stepIndex: variant.stepIndex, hourLocal: variant.hourLocal },
          { $inc: { clicked: -1 } },
        );
    }
  }
  return true;
}

/**
 * Two stamps for the same moment.
 *
 * Via `String()` this silently lost milliseconds — a Date stringifies to second precision —
 * so a signal never matched the timestamp taken from the very same field, and the first
 * run of the reclassifier moved seven signals without flagging one of them.
 */
const sameInstant = (a: unknown, b: Date): boolean => {
  if (a instanceof Date) return a.getTime() === b.getTime();
  const left = a ? new Date(String(a)).getTime() : NaN;
  return left === b.getTime();
};

/**
 * A scanner has just walked the unsubscribe link. Anything it "clicked" moments earlier was
 * the same pass over the same message.
 *
 * Ten seconds, because the window has to be short enough that a person who read the mail,
 * followed the call to action and then decided to leave is never caught by it — they would
 * have to load a page and come back inside it. The gateways this was written for did both
 * within two seconds.
 */
export async function markScannerPass(personId: string, at: Date, withinMs = 10_000): Promise<number> {
  if (!ObjectId.isValid(personId)) return 0;
  const db = await getDb();
  const since = new Date(at.getTime() - withinMs);
  let moved = 0;

  for (const type of ["clicked", "opened"] as const) {
    const field = signalField(type, false);
    const actions = await db
      .collection(C.actions)
      .find({ personId, [field]: { $gte: since, $lte: at } }, { projection: { _id: 1 } })
      .toArray();
    for (const action of actions) if (await demoteToMachine(action._id, type)) moved++;
  }
  return moved;
}
