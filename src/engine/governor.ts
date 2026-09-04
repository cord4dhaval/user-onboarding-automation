import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

export interface RateLimits {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
}

/**
 * Every window is rolling, not calendar: the daily cap frees a slot 24 hours after each
 * send, rather than all at once at midnight.
 */
const WINDOWS: Array<[keyof RateLimits, number, string]> = [
  ["perMinute", 60_000, "per-minute"],
  ["perHour", 3_600_000, "hourly"],
  ["perDay", 86_400_000, "daily"],
];

export interface RateBlock {
  reason: string;
  /**
   * When this window frees its next slot. Always set for a rate block, because every
   * window is rolling — which is what makes a rate limit a delay rather than a verdict.
   */
  retryAt: Date;
}

/**
 * Rate limiting is measured from what was actually sent, not from a counter kept on the
 * channel document. Counting real rows is correct across concurrent workers and survives
 * restarts, where a hand-maintained rolling window quietly drifts.
 *
 * Returns when the block lifts, not merely that it exists. A caller that only knows "the
 * cap is full" has no better option than throwing the message away; one that knows the
 * window frees at 09:06 can put it back in the queue for 09:06.
 */
export async function rateBlock(
  orgId: string,
  channelId: string,
  limits: RateLimits,
  now = new Date(),
): Promise<RateBlock | null> {
  const db = await getDb();

  for (const [key, ms, label] of WINDOWS) {
    const limit = limits[key];
    if (!limit) continue;
    const since = new Date(now.getTime() - ms);
    const used = await db
      .collection(C.actions)
      .countDocuments({ orgId, channelId, sentAt: { $gte: since } });
    if (used < limit) continue;

    // The oldest send still inside the window is the one whose slot comes back first.
    const oldest = await db
      .collection(C.actions)
      .find({ orgId, channelId, sentAt: { $gte: since } })
      .sort({ sentAt: 1 })
      .limit(1)
      .project({ sentAt: 1 })
      .toArray();
    const at = oldest[0]?.sentAt ? new Date(String(oldest[0].sentAt)) : undefined;

    return {
      reason: `${label} send limit reached (${used}/${limit})`,
      // A full window with nothing in it cannot happen, but a clock skew could produce it.
      // Waiting out the whole window is the safe reading.
      retryAt: at ? new Date(at.getTime() + ms) : new Date(now.getTime() + ms),
    };
  }
  return null;
}

export interface WindowUsage {
  label: string;
  used: number;
  limit: number;
  /** How many more may go out right now. */
  free: number;
  /**
   * When the oldest send in this window ages out and frees one slot. Every window is
   * rolling, so this is always meaningful — a cap does not refill at midnight, it drips.
   */
  freesAt?: Date;
}

/**
 * What each limit has actually spent, counted the same way the send path counts it.
 *
 * The channels page used to read `governor.sentToday`, a counter incremented on send and
 * reset by nothing, so the number it showed drifted further from reality every day. This
 * asks the same question the governor asks, so the screen and the gate cannot disagree.
 */
export async function channelUsage(
  orgId: string,
  channelId: string,
  limits: RateLimits,
  now = new Date(),
): Promise<WindowUsage[]> {
  const db = await getDb();
  const out: WindowUsage[] = [];

  for (const [key, ms, label] of WINDOWS) {
    const limit = limits[key];
    if (!limit) continue;
    const since = new Date(now.getTime() - ms);
    const used = await db
      .collection(C.actions)
      .countDocuments({ orgId, channelId, sentAt: { $gte: since } });

    // Read even when the window has room. "47 of 50" looks like a calendar-day count and
    // is not one: three of those slots came back on their own while this page was open,
    // and the next one has a time. Saying when is the difference between a number people
    // trust and one they file a bug about.
    const oldest = await db
      .collection(C.actions)
      .find({ orgId, channelId, sentAt: { $gte: since } })
      .sort({ sentAt: 1 })
      .limit(1)
      .project({ sentAt: 1 })
      .toArray();
    const at = oldest[0]?.sentAt ? new Date(String(oldest[0].sentAt)) : undefined;

    out.push({
      label,
      used,
      limit,
      free: Math.max(0, limit - used),
      freesAt: at ? new Date(at.getTime() + ms) : undefined,
    });
  }
  return out;
}

/**
 * The ceiling a mailbox provider enforces that nobody declared to us.
 *
 * A daily cap alone does not describe how a mailbox actually behaves: providers refuse on
 * an hourly window long before the day is spent, and a queue that only knows the day will
 * empty itself into the first hour and lose the overflow. This product sent 103 messages
 * in one hour against a provider limit of 100 and burned 50 touches to `hourly_cap`
 * rejections, each one a real message a real person never received.
 *
 * Deliberately below any provider's real number. A cap that is slightly too low delays a
 * message; one that is slightly too high destroys it.
 */
const DEFAULT_PER_HOUR = 90;

/**
 * Reads the provider's declared limits off the channel, with conservative defaults.
 *
 * An hourly figure is assumed where none is declared, because the failure modes are not
 * symmetric: pacing a message an hour later costs an hour, and exceeding a provider's
 * window costs the message.
 */
export async function limitsFor(orgId: string, channelId: string): Promise<RateLimits> {
  const db = await getDb();
  const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId), orgId });
  const governor = (channel?.governor ?? {}) as { perMinute?: number; perHour?: number; dailyCap?: number };
  return {
    perMinute: governor.perMinute,
    perHour: governor.perHour ?? DEFAULT_PER_HOUR,
    perDay: governor.dailyCap,
  };
}
