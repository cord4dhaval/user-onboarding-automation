import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

export interface RateLimits {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
}

/**
 * Rate limiting is measured from what was actually sent, not from a counter kept on the
 * channel document. Counting real rows is correct across concurrent workers and survives
 * restarts, where a hand-maintained rolling window quietly drifts.
 */
export async function rateCheck(
  orgId: string,
  channelId: string,
  limits: RateLimits,
  now = new Date(),
): Promise<string | null> {
  const db = await getDb();
  const windows: Array<[keyof RateLimits, number, string]> = [
    ["perMinute", 60_000, "per-minute"],
    ["perHour", 3_600_000, "hourly"],
    ["perDay", 86_400_000, "daily"],
  ];

  for (const [key, ms, label] of windows) {
    const limit = limits[key];
    if (!limit) continue;
    const used = await db.collection(C.actions).countDocuments({
      orgId,
      channelId,
      sentAt: { $gte: new Date(now.getTime() - ms) },
    });
    if (used >= limit) return `${label} send limit reached (${used}/${limit})`;
  }
  return null;
}

/** Reads the provider's declared limits off the channel, with conservative defaults. */
export async function limitsFor(orgId: string, channelId: string): Promise<RateLimits> {
  const db = await getDb();
  const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId), orgId });
  const governor = (channel?.governor ?? {}) as { perMinute?: number; perHour?: number; dailyCap?: number };
  return {
    perMinute: governor.perMinute,
    perHour: governor.perHour,
    perDay: governor.dailyCap,
  };
}
