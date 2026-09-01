import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Severity is about what a person should do, not how the system feels.
 *
 * critical — something is broken and sending is affected
 * action   — a person is personally blocking something
 * good     — worth knowing, needs nothing
 *
 * Anything that needs no decision is activity, not a notification, and never reaches the
 * bell. "Source ran, three leads" is activity. "Source has failed four times" is not.
 */
export type Severity = "critical" | "action" | "good";

export interface NotificationInput {
  orgId: string;
  productId: string;
  severity: Severity;
  title: string;
  body?: string;
  href?: string;
  /** Repeat events with the same key collapse into one row instead of stacking. */
  dedupeKey: string;
}

export async function notify(input: NotificationInput): Promise<void> {
  const db = await getDb();
  const now = new Date();

  await db.collection(C.notifications).updateOne(
    { orgId: input.orgId, productId: input.productId, dedupeKey: input.dedupeKey, readAt: null },
    {
      $set: {
        severity: input.severity,
        title: input.title,
        body: input.body,
        href: input.href,
        updatedAt: now,
      },
      $inc: { count: 1 },
      $setOnInsert: {
        orgId: input.orgId,
        productId: input.productId,
        dedupeKey: input.dedupeKey,
        createdAt: now,
        readAt: null,
      },
    },
    { upsert: true },
  );
}

export interface NotificationRow {
  id: string;
  severity: Severity;
  title: string;
  body?: string;
  href?: string;
  count: number;
  at: string;
  read: boolean;
}

export async function listNotifications(
  orgId: string,
  productId: string,
  includeRead = false,
): Promise<NotificationRow[]> {
  const db = await getDb();
  const rows = await db
    .collection(C.notifications)
    .find({ orgId, productId, ...(includeRead ? {} : { readAt: null }) })
    .sort({ updatedAt: -1 })
    .limit(40)
    .toArray();

  return rows.map((r) => ({
    id: String(r._id),
    severity: r.severity as Severity,
    title: String(r.title),
    body: r.body ? String(r.body) : undefined,
    href: r.href ? String(r.href) : undefined,
    count: Number(r.count ?? 1),
    at: new Date(String(r.updatedAt)).toISOString(),
    read: Boolean(r.readAt),
  }));
}

export async function markRead(orgId: string, ids: string[]): Promise<number> {
  const db = await getDb();
  const result = await db
    .collection(C.notifications)
    .updateMany(
      { orgId, _id: { $in: ids.map((id) => new ObjectId(id)) }, readAt: null },
      { $set: { readAt: new Date() } },
    );
  return result.modifiedCount;
}

export async function markAllRead(orgId: string, productId: string): Promise<number> {
  const db = await getDb();
  const result = await db
    .collection(C.notifications)
    .updateMany({ orgId, productId, readAt: null }, { $set: { readAt: new Date() } });
  return result.modifiedCount;
}

/**
 * Rebuilds the notifications the engine can work out from current state, so the bell
 * reflects reality even for conditions nothing explicitly reported — a channel that went
 * degraded between runs, or messages that piled up waiting for review.
 */
export async function refreshDerived(orgId: string, productId: string): Promise<void> {
  const db = await getDb();
  const scope = { orgId, productId };
  const base = `/products/${productId}`;

  const held = await db.collection(C.actions).countDocuments({ ...scope, status: "awaiting_approval" });
  if (held > 0) {
    await notify({
      ...scope,
      severity: "action",
      dedupeKey: "review:pending",
      title: `${held} message${held === 1 ? "" : "s"} waiting for review`,
      body: "Nothing goes out until you approve it.",
      href: `${base}/review`,
    });
  }

  for (const channel of await db.collection(C.channels).find({ ...scope, enabled: true }).toArray()) {
    if (channel.status === "healthy") continue;
    await notify({
      ...scope,
      severity: "critical",
      dedupeKey: `channel:${String(channel._id)}`,
      title: `The ${String(channel.key)} channel is ${String(channel.status)}`,
      body: "Messages on this channel cannot be delivered until it is reconnected.",
      href: `${base}/channels`,
    });
  }

  for (const source of await db.collection(C.sources).find({ ...scope, enabled: true }).toArray()) {
    const health = source.health as { status?: string; error?: string } | undefined;
    if (health?.status !== "degraded") continue;
    await notify({
      ...scope,
      severity: "critical",
      dedupeKey: `source:${String(source._id)}`,
      title: `Source "${String(source.name)}" is failing`,
      body: health.error,
      href: `${base}/goals`,
    });
  }

  const unclassified = await db.collection(C.people).countDocuments({ ...scope, needsClassification: true });
  if (unclassified >= 5) {
    await notify({
      ...scope,
      severity: "action",
      dedupeKey: "claude:backlog",
      title: `${unclassified} leads are waiting on Claude`,
      body: "They get a plan on the next routine run. Run a sweep now if you would rather not wait.",
      href: `${base}/claude`,
    });
  }
}
