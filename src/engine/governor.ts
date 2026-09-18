import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

export interface RateLimits {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  perWeek?: number;
}

/**
 * Which sends a limit counts, and what to call them in its reason. Absent means every send
 * on the channel; set, it narrows the count to one kind of action — LinkedIn allows far
 * fewer invites than messages, and one shared number could only ever be wrong for one of
 * them.
 */
export interface RateScope {
  match: Record<string, unknown>;
  what: string;
}

/**
 * Every window is rolling, not calendar: the daily cap frees a slot 24 hours after each
 * send, rather than all at once at midnight.
 */
const WINDOWS: Array<[keyof RateLimits, number, string]> = [
  ["perMinute", 60_000, "per-minute"],
  ["perHour", 3_600_000, "hourly"],
  ["perDay", 86_400_000, "daily"],
  ["perWeek", 7 * 86_400_000, "weekly"],
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
  scope?: RateScope,
): Promise<RateBlock | null> {
  const db = await getDb();

  for (const [key, ms, label] of WINDOWS) {
    const limit = limits[key];
    if (!limit) continue;
    const since = new Date(now.getTime() - ms);
    const used = await db
      .collection(C.actions)
      .countDocuments({ orgId, channelId, sentAt: { $gte: since }, ...scope?.match });
    if (used < limit) continue;

    // The oldest send still inside the window is the one whose slot comes back first.
    const oldest = await db
      .collection(C.actions)
      .find({ orgId, channelId, sentAt: { $gte: since }, ...scope?.match })
      .sort({ sentAt: 1 })
      .limit(1)
      .project({ sentAt: 1 })
      .toArray();
    const at = oldest[0]?.sentAt ? new Date(String(oldest[0].sentAt)) : undefined;

    return {
      reason: `${label} ${scope?.what ?? "send"} limit reached (${used}/${limit})`,
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
  scope?: RateScope,
): Promise<WindowUsage[]> {
  const db = await getDb();
  const out: WindowUsage[] = [];

  for (const [key, ms, label] of WINDOWS) {
    const limit = limits[key];
    if (!limit) continue;
    const since = new Date(now.getTime() - ms);
    const used = await db
      .collection(C.actions)
      .countDocuments({ orgId, channelId, sentAt: { $gte: since }, ...scope?.match });

    // Read even when the window has room. "47 of 50" looks like a calendar-day count and
    // is not one: three of those slots came back on their own while this page was open,
    // and the next one has a time. Saying when is the difference between a number people
    // trust and one they file a bug about.
    const oldest = await db
      .collection(C.actions)
      .find({ orgId, channelId, sentAt: { $gte: since }, ...scope?.match })
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
  const governor = (channel?.governor ?? {}) as {
    perMinute?: number;
    perHour?: number;
    dailyCap?: number;
    perWeek?: number;
  };
  return {
    perMinute: governor.perMinute,
    perHour: governor.perHour ?? DEFAULT_PER_HOUR,
    perDay: governor.dailyCap,
    perWeek: governor.perWeek,
  };
}

/**
 * How many messages this channel may still send right now, across every window at once.
 *
 * `rateBlock` answers "is it full", which is the right question when messages leave one at
 * a time: each send is counted before the next one is decided. It is the wrong question
 * when several go out together — eight concurrent sends all read the same count, all see
 * room, and all go, so a cap of ten becomes whatever the batch size was.
 *
 * Asking for the number instead makes the batch size the thing the limit constrains. The
 * caller takes min(batch, headroom) and the cap holds however wide the fan-out is.
 */
export async function rateHeadroom(
  orgId: string,
  channelId: string,
  limits: RateLimits,
  now = new Date(),
): Promise<number> {
  const db = await getDb();
  let headroom = Number.POSITIVE_INFINITY;

  for (const [key, ms] of WINDOWS) {
    const limit = limits[key];
    if (!limit) continue;
    const used = await db
      .collection(C.actions)
      .countDocuments({ orgId, channelId, sentAt: { $gte: new Date(now.getTime() - ms) } });
    headroom = Math.min(headroom, limit - used);
  }

  // No limits configured is not unlimited concurrency. The caller's own batch size is the
  // remaining bound, and returning Infinity would hand it a fan-out of whatever was due.
  return Number.isFinite(headroom) ? Math.max(0, headroom) : Number.MAX_SAFE_INTEGER;
}

/**
 * A limit on one kind of action rather than on every send. LinkedIn is the case that needs
 * it: an account that sends thirty messages a day is ordinary and one that sends thirty
 * invites a day is on its way to a restriction.
 */
export interface OpLimit {
  /** The action types counted together. A reply spends the same allowance as a comment. */
  ops: string[];
  /** What the reason calls them: "daily invite limit reached (10/10)". */
  label: string;
  /** The day cap on the day the account was connected. */
  startPerDay: number;
  /** Where the day cap ends up once the warm-up has run. */
  maxPerDay: number;
  perWeek?: number;
}

/** How many weeks the day cap takes to climb from its start to its ceiling. */
const RAMP_WEEKS = 4;

/**
 * The day cap for one kind of action, this week.
 *
 * It climbs in weekly steps from the account's connection, because a new account that goes
 * straight to the ceiling looks nothing like a person and everything like a tool. Stepped
 * rather than smooth so the number a person reads on Monday is still the number on Friday.
 */
export function rampedPerDay(limit: OpLimit, warmupStartedAt: Date | undefined, now = new Date()): number {
  if (!warmupStartedAt) return limit.startPerDay;
  const weeks = Math.max(0, Math.floor((now.getTime() - new Date(warmupStartedAt).getTime()) / (7 * 86_400_000)));
  const step = ((limit.maxPerDay - limit.startPerDay) * Math.min(weeks, RAMP_WEEKS)) / RAMP_WEEKS;
  return Math.min(limit.maxPerDay, Math.round(limit.startPerDay + step));
}

/**
 * The limits and the count scope for one action type on a channel, or null where the
 * channel sets none for it.
 */
export function opLimitsFor(
  governor: Record<string, unknown> | undefined,
  op: string,
  now = new Date(),
): { limits: RateLimits; scope: RateScope } | null {
  const perOp = (governor?.perOp ?? []) as OpLimit[];
  const limit = perOp.find((l) => l.ops.includes(op));
  if (!limit) return null;
  // Not `windowStartedAt`: saving the channel's settings resets that one, and a settings
  // save must not send a month-old account back to its first-day caps, or a new one to its
  // ceiling. Absent means the start caps, which is the safe way to be wrong.
  const warmup = governor?.warmupStartedAt as Date | undefined;
  return {
    limits: { perDay: rampedPerDay(limit, warmup, now), perWeek: limit.perWeek },
    scope: { match: { op: { $in: limit.ops } }, what: limit.label },
  };
}

/**
 * The earliest the channel may send again, where it paces its sends at random intervals.
 *
 * Fixed caps alone let a queue drain as fast as the windows allow, so a day's allowance goes
 * out in a burst at one-minute intervals. A person does not work like that, and LinkedIn
 * notices when an account does. The next slot is drawn when a send lands, stored on the
 * channel, and every later message waits for it.
 */
export function spacedUntil(governor: Record<string, unknown> | undefined, now = new Date()): Date | null {
  const next = governor?.nextSendAt ? new Date(String(governor.nextSendAt)) : null;
  return next && next > now ? next : null;
}

/** Draws the next send slot for a channel that paces at random, or null where it does not. */
export function nextSpacedSlot(governor: Record<string, unknown> | undefined, from = new Date()): Date | null {
  const spacing = governor?.spacing as { minSec: number; maxSec: number } | undefined;
  if (!spacing) return null;
  const sec = spacing.minSec + Math.random() * Math.max(0, spacing.maxSec - spacing.minSec);
  return new Date(from.getTime() + Math.round(sec) * 1000);
}
