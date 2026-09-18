/**
 * What a LinkedIn account may do in a day and a week, written onto the channel when it is
 * connected. The numbers are LinkedIn's unwritten ones, kept well under where accounts are
 * known to get restricted, and every one of them is on the channel document afterwards, so
 * a product can tune its own account without a deploy.
 *
 *   action          start/day   max/day   max/week
 *   invite          10          30        100
 *   message         20          50        --
 *   comment/reply   10          30        --
 *   spacing         random 2-9 minutes between any two actions
 *
 * The day caps climb weekly from the connection to the max over four weeks (see
 * rampedPerDay). Profile views have no cap of their own: the send path looks a lead up once
 * and caches the member id, so views are bounded by the invite cap.
 */

import type { OpLimit } from "../../../engine/governor.js";

/** LinkedIn's own ceiling on a direct message. */
export const MESSAGE_MAX_CHARS = 8000;
/**
 * The invite note. 300 on a paid account, 200 on a free one; the tighter one until the
 * account's plan is known.
 */
export const INVITE_NOTE_MAX_CHARS = 200;

export const OP_LIMITS: OpLimit[] = [
  { ops: ["invite"], label: "invite", startPerDay: 10, maxPerDay: 30, perWeek: 100 },
  { ops: ["message"], label: "message", startPerDay: 20, maxPerDay: 50 },
  { ops: ["comment", "reply"], label: "comment", startPerDay: 10, maxPerDay: 30 },
];

export function linkedinGovernor(connectedAt: Date) {
  return {
    // No overall day cap: the per-action caps are the day's limit, and one number across
    // invites and messages would be too tight for one or too loose for the other.
    dailyCap: 0,
    perMinute: 1,
    perHour: 6,
    perOp: OP_LIMITS,
    spacing: { minSec: 120, maxSec: 540 },
    warmupStartedAt: connectedAt,
    warmupDay: 1,
    sentToday: 0,
    windowStartedAt: connectedAt,
  };
}
