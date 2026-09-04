import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

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

export interface Engagement {
  /** Messages the provider accepted. Queued and held ones are not sends. */
  sent: number;
  /** Sends carrying a tracking pixel or wrapped links — the only honest denominator. */
  trackable: number;
  opened: number;
  clicked: number;
  /** People who wrote back, not messages: one reply answers a thread, not a send. */
  replied: number;
  unsubscribed: number;
  bounced: number;
  failed: number;
}

const empty = (): Engagement => ({
  sent: 0,
  trackable: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  unsubscribed: 0,
  bounced: 0,
  failed: 0,
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
          sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "dispatched"]] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          trackable: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$status", ["sent", "dispatched"]] },
                    { $ne: [{ $ifNull: ["$tracking.clicks", false] }, false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          opened: { $sum: { $cond: [{ $ifNull: ["$firstOpenedAt", false] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  for (const row of rows) {
    Object.assign(of(String(row._id)), {
      sent: Number(row.sent ?? 0),
      trackable: Number(row.trackable ?? 0),
      opened: Number(row.opened ?? 0),
      clicked: Number(row.clicked ?? 0),
    });
    of(String(row._id)).failed = Number(row.failed ?? 0);
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
      { $match: { orgId, productId, personId: { $in: personIds } } },
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
    await db.collection(C.actions).distinct("personId", { orgId, productId, [field]: { $exists: true } })
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
  actionId: string;
  subject?: string;
}

export function signalsOf(actions: Document[]): Signal[] {
  const out: Signal[] = [];
  for (const action of actions) {
    const subject = (action.content as { subject?: string } | undefined)?.subject;
    const recorded = (action.signals ?? []) as Array<{ type?: string; at?: unknown; url?: unknown }>;
    const seen = new Set<string>();

    for (const signal of recorded) {
      if (signal.type !== "opened" && signal.type !== "clicked") continue;
      if (!signal.at) continue;
      seen.add(signal.type);
      out.push({
        type: signal.type,
        at: new Date(String(signal.at)),
        url: signal.url ? String(signal.url) : undefined,
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
