import { ObjectId, type Filter, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { AudienceFilter } from "../schemas/audience.js";

/**
 * The library is every person this product has ever touched. Campaigns write into it as a
 * side effect of ingest, and audiences read back out of it — that loop is what stops
 * anyone falling out of the system when a campaign ends.
 */

export interface LibraryQuery {
  search?: string;
  lifecycle?: string[];
  segment?: string;
  hasCampaign?: boolean;
  /** A goal key — narrows to people some instance of that campaign has run on. */
  campaign?: string;
  /** How far a message to them got: "sent" is handed off, "delivered" is confirmed. */
  delivery?: DeliveryState;
  limit?: number;
  skip?: number;
}

export type DeliveryState = "sent" | "delivered" | "failed" | "pending";

/**
 * Delivery lives on actions, not on people, because one person can hold several messages
 * in different states. Asking "who has a sent message" is therefore a question about
 * actions answered as a list of people.
 */
const DELIVERY_MATCH: Record<DeliveryState, Filter<Document>> = {
  sent: { status: "sent" },
  delivered: { status: "sent", confirmedAt: { $exists: true } },
  failed: { status: "failed" },
  pending: { status: { $in: ["queued", "held", "awaiting_approval", "sending", "dispatched"] } },
};

export async function queryLibrary(orgId: string, productId: string, q: LibraryQuery = {}) {
  const db = await getDb();
  const filter: Filter<Document> = { orgId, productId };

  if (q.search?.trim()) {
    const rx = new RegExp(escapeRegex(q.search.trim()), "i");
    filter.$or = [{ primaryEmail: rx }, { name: rx }, { companyDomain: rx }];
  }
  if (q.lifecycle?.length) filter.lifecycle = { $in: q.lifecycle };
  if (q.segment) filter["belief.segment"] = q.segment;

  // Campaign and delivery are both facts about other collections, so each resolves to a
  // list of people first and the lists are intersected — two narrowings, not two queries
  // that quietly widen each other.
  const narrowings: string[][] = [];
  if (q.campaign) {
    narrowings.push(
      (await db.collection(C.goalInstances).distinct("personId", { orgId, productId, goalKey: q.campaign })).map(String),
    );
  }
  if (q.delivery) {
    narrowings.push(
      (await db.collection(C.actions).distinct("personId", { orgId, productId, ...DELIVERY_MATCH[q.delivery] }))
        .map(String),
    );
  }
  if (narrowings.length > 0) {
    const ids = narrowings.reduce((a, b) => a.filter((id) => b.includes(id)));
    filter._id = { $in: ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) };
  }

  const [rows, total] = await Promise.all([
    db.collection(C.people).find(filter).sort({ createdAt: -1 }).skip(q.skip ?? 0).limit(q.limit ?? 50).toArray(),
    db.collection(C.people).countDocuments(filter),
  ]);
  return { rows, total };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turns a saved filter into a Mongo query.
 *
 * Suppression is excluded unless someone deliberately turns that off, because a person who
 * said no must never be picked up by a filter written months later.
 */
export function audienceQuery(orgId: string, productId: string, f: AudienceFilter): Filter<Document> {
  const filter: Filter<Document> = { orgId, productId };
  const now = Date.now();

  if (f.excludeSuppressed !== false) {
    filter.suppressedAt = { $exists: false };
    filter.lifecycle = { $ne: "suppressed" };
  }
  if (f.lifecycle?.length) filter.lifecycle = { $in: f.lifecycle };
  if (f.segments?.length) filter["belief.segment"] = { $in: f.segments };
  if (f.stages?.length) filter.stage = { $in: f.stages };
  if (f.temperature?.length) filter["temp.band"] = { $in: f.temperature };
  if (typeof f.minIcpFit === "number") filter["belief.icpFit"] = { $gte: f.minIcpFit };
  if (f.companyDomains?.length) filter.companyDomain = { $in: f.companyDomains };

  // "Silent" counts from the last message we sent; "quiet" from the last thing they did.
  if (typeof f.silentDays === "number") {
    filter.$or = [
      { lastContactedAt: { $lte: new Date(now - f.silentDays * 86_400_000) } },
      { lastContactedAt: { $exists: false } },
    ];
  }
  if (typeof f.quietDays === "number") {
    filter.lastSignalAt = { $lte: new Date(now - f.quietDays * 86_400_000) };
  }
  if (f.everEngaged === true) filter.lastSignalAt = { $exists: true };

  return filter;
}

export async function audienceMembers(
  orgId: string,
  productId: string,
  audienceId: string,
  limit = 500,
): Promise<string[]> {
  const db = await getDb();
  const audience = await db.collection(C.audiences).findOne({ _id: new ObjectId(audienceId), orgId, productId });
  if (!audience) throw new Error("audience not found");

  if (audience.kind === "static") return (audience.personIds as string[]) ?? [];

  const rows = await db
    .collection(C.people)
    .find(audienceQuery(orgId, productId, (audience.filter ?? {}) as AudienceFilter))
    .project({ _id: 1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => String(r._id));
}

export async function audienceCount(orgId: string, productId: string, audience: Document): Promise<number> {
  const db = await getDb();
  if (audience.kind === "static") return ((audience.personIds as string[]) ?? []).length;
  return db
    .collection(C.people)
    .countDocuments(audienceQuery(orgId, productId, (audience.filter ?? {}) as AudienceFilter));
}

export interface PersonHistory {
  person: Document;
  campaigns: Document[];
  actions: Document[];
  plans: Document[];
  events: Document[];
}

/**
 * Everything ever done to one person, in one read. Old plans are kept rather than replaced,
 * so the reasoning behind a message sent months ago is still answerable.
 */
export async function personHistory(orgId: string, productId: string, personId: string): Promise<PersonHistory | null> {
  const db = await getDb();
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId), orgId, productId });
  if (!person) return null;

  const campaigns = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, personId })
    .sort({ startedAt: 1 })
    .toArray();

  const [actions, plans, events] = await Promise.all([
    db.collection(C.actions).find({ orgId, productId, personId }).sort({ dueAt: 1 }).toArray(),
    db
      .collection(C.plans)
      .find({ goalInstanceId: { $in: campaigns.map((c) => String(c._id)) } })
      .sort({ createdAt: 1 })
      .toArray(),
    db.collection(C.events).find({ orgId, personId }).sort({ ts: 1 }).limit(200).toArray(),
  ]);

  return { person, campaigns, actions, plans, events };
}

/** Records an arrival without ever creating a second record for the same human. */
export async function recordArrival(
  personId: ObjectId,
  arrival: { sourceId?: string; kind: string; detail?: string },
): Promise<void> {
  const db = await getDb();
  await db.collection(C.people).updateOne({ _id: personId }, {
    $push: { arrivals: { ...arrival, at: new Date() } },
  } as never);
}
