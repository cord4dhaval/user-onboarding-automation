import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { replyReach } from "./reach.js";

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

  // Not the same notice as the one above, and deliberately louder. "52 messages waiting"
  // is a chore; "3 of them are for people who clicked this week" is a decision with a
  // deadline, and the first was burying the second inside its own count.
  const warm = (
    await db
      .collection(C.people)
      .find({ ...scope, "temp.band": "hot" }, { projection: { _id: 1 } })
      .toArray()
  ).map((p) => String(p._id));

  if (warm.length > 0) {
    // Undecided, whichever side of the gate it is on. Every message to a recent responder
    // on this product was sitting under Scheduled dated days out, so counting only what had
    // reached the gate would have reported none of them.
    const pending = await db
      .collection(C.actions)
      .find(
        {
          ...scope,
          status: { $in: ["awaiting_approval", "queued"] },
          reviewedAt: { $exists: false },
          personId: { $in: warm },
        },
        { projection: { dueAt: 1, status: 1 } },
      )
      .sort({ dueAt: 1 })
      .toArray();

    if (pending.length > 0) {
      const atGate = pending.filter((a) => a.status === "awaiting_approval").length;
      const soonest = pending[0]?.dueAt ? new Date(String(pending[0].dueAt)) : undefined;
      const waitDays = soonest ? Math.round((soonest.getTime() - Date.now()) / 86_400_000) : 0;
      await notify({
        ...scope,
        severity: "action",
        dedupeKey: "review:hot",
        title: `${pending.length} message${pending.length === 1 ? "" : "s"} to people who just responded ${
          pending.length === 1 ? "is" : "are"
        } undecided`,
        body:
          waitDays >= 1
            ? `They clicked or wrote back in the last few days and the next message to them is not due for ${waitDays} day${waitDays === 1 ? "" : "s"}. Approving early sends it on its date without stopping again.`
            : "They clicked or wrote back recently. A message while they are still interested is worth more than the same words next week.",
        href: `${base}/review${atGate > 0 ? "" : "?view=scheduled"}`,
      });
    }
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

  // A campaign that cannot hear an answer is not a campaign, it is a broadcast. This one
  // had sent a hundred and fifty messages and read none of the replies, and the console
  // reported that as "0 replied" — a measurement, rather than the missing mailbox it was.
  const sent = await db.collection(C.actions).countDocuments({ ...scope, status: "sent" });
  if (sent > 0) {
    const reach = await replyReach(orgId, productId);
    if (!reach.replies) {
      await notify({
        ...scope,
        severity: "critical",
        dedupeKey: "reach:no_inbound",
        title: `${sent} message${sent === 1 ? "" : "s"} sent, and nothing is reading the replies`,
        body: `${reach.why}. Anyone who wrote back is waiting in a mailbox this product cannot open — connect one on Channels.`,
        href: `${base}/channels`,
      });
    }
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
