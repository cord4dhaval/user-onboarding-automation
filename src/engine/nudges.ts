import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { activeInstanceFor } from "./instances.js";

const HOUR = 3_600_000;

export interface NudgeSummary {
  candidates: number;
  nudged: number;
  skipped: Record<string, number>;
}

/**
 * One reminder for somebody who started registering and did not finish.
 *
 * Driven only by the register page's own `register_started` event, never by a click on the
 * trial link. Until the site also reports `signed_up`, a click cannot tell a person who
 * left the page from one who created an account, and chasing a new customer with "one step
 * left" is worse than saying nothing.
 *
 * Three hours after they started, and not after two days, one mail at most per campaign,
 * never while another mail is about to go, and queued like any other so the campaign's
 * approval setting decides whether a person reads it first. A signup that arrives after it
 * is queued closes the campaign, which skips it.
 */
export async function nudgeStartedRegistrations(
  orgId: string,
  productId: string,
  now = new Date(),
  opts: { dryRun?: boolean } = {},
): Promise<NudgeSummary> {
  const db = await getDb();
  const summary: NudgeSummary = { candidates: 0, nudged: 0, skipped: {} };
  const skip = (why: string) => {
    summary.skipped[why] = (summary.skipped[why] ?? 0) + 1;
  };

  const template = await db
    .collection(C.templates)
    .findOne({ orgId, productId, key: "one_step_left", status: "active" }, { projection: { _id: 1 } });
  if (!template) return summary;

  const started = await db
    .collection(C.events)
    .aggregate([
      {
        $match: {
          orgId,
          productId,
          type: "site_event:register_started",
          ts: { $gte: new Date(now.getTime() - 48 * HOUR), $lte: new Date(now.getTime() - 3 * HOUR) },
        },
      },
      { $group: { _id: "$personId", at: { $max: "$ts" } } },
      { $limit: 200 },
    ])
    .toArray();

  for (const row of started) {
    summary.candidates++;
    const personId = String(row._id);
    const startedAt = row.at as Date;

    const instance = await activeInstanceFor({ orgId, productId, personId });
    if (!instance) { skip("no open campaign"); continue; }
    if (instance.handedOverAt) { skip("handed over to a person"); continue; }

    const finished = await db
      .collection(C.events)
      .findOne({ orgId, personId, type: "site_event:signed_up", ts: { $gte: startedAt } }, { projection: { _id: 1 } });
    if (finished) { skip("signed up"); continue; }

    const goalInstanceId = String(instance._id);
    const already = await db.collection(C.actions).findOne({ goalInstanceId, angle: "one_step_left" }, { projection: { _id: 1 } });
    if (already) { skip("already nudged"); continue; }

    const dueSoon = await db.collection(C.actions).findOne(
      { goalInstanceId, status: { $in: ["queued", "awaiting_approval", "sending"] }, dueAt: { $lte: new Date(now.getTime() + 12 * HOUR) } },
      { projection: { _id: 1 } },
    );
    if (dueSoon) { skip("another mail is due within 12 hours"); continue; }

    const lastSend = await db
      .collection(C.actions)
      .find({ goalInstanceId, status: { $in: ["sent", "dispatched"] }, channelId: { $exists: true } })
      .sort({ sentAt: -1 })
      .limit(1)
      .next();
    const channel =
      (lastSend?.channelId
        ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(lastSend.channelId)), enabled: true, status: "healthy" })
        : null) ?? (await db.collection(C.channels).findOne({ orgId, productId, key: "email", enabled: true, status: "healthy" }));
    if (!channel) { skip("no healthy mailbox"); continue; }

    if (opts.dryRun) { summary.nudged++; continue; }
    try {
      await db.collection(C.actions).insertOne({
        _id: new ObjectId(),
        orgId,
        productId,
        goalInstanceId,
        personId,
        templateId: String(template._id),
        channel: String(channel.key),
        channelId: String(channel._id),
        angle: "one_step_left",
        rationale: `Started registering ${Math.round((now.getTime() - startedAt.getTime()) / HOUR)} hours ago and has no account yet.`,
        content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
        assetIds: [],
        next: {},
        signals: [],
        idempotencyKey: `${goalInstanceId}:nudge:one_step_left`,
        status: "queued",
        dueAt: now,
        cost: 0,
      });
      summary.nudged++;
    } catch (err) {
      if (err instanceof Error && err.message.includes("E11000")) { skip("already nudged"); continue; }
      throw err;
    }
  }
  return summary;
}
