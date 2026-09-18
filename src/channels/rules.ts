import type { ChannelKey } from "../schemas/common.js";
import type { OpLimit } from "../engine/governor.js";

/**
 * How each channel is worked, as data: the limits and pacing the engine enforces, and the
 * writing rules a session reads before it writes for that channel.
 *
 * Three layers, so a second product never needs a code change:
 *   1. the engine's mechanics (fireDue, governor) read these values;
 *   2. the defaults below are the channel's rules for every product;
 *   3. a product overrides any of them in `product.config.channelRules[channel]`.
 * What a message says about the product itself (ideas, voice, the ask) is product data and
 * never lives here.
 *
 * Only channels built this way are listed. Email is not, and keeps its rules where they
 * have always been; this registry is how new channels arrive without touching it.
 */
export interface ChannelRules {
  /**
   * Local hours a message may go out in, as the quiet window [from, until): LinkedIn's
   * [11, 7] means 07:00 to 11:00 in the lead's own timezone.
   */
  quietHours?: [number, number];
  /** Per-action caps, rising weekly from connection. See governor.opLimitsFor. */
  perOp?: OpLimit[];
  /** A random wait between any two sends on one account. */
  spacing?: { minSec: number; maxSec: number };
  perMinute?: number;
  perHour?: number;
  /** Characters. `note` is a connection note, far shorter than a message. */
  maxLength?: { note?: number; message?: number };
  /** Hours a touch is given to be answered before the next one is planned. */
  watchWindowHours?: number;
  /** An invite nobody accepted in this many days is withdrawn. */
  withdrawAfterDays?: number;
  /**
   * Invites stop when too few are accepted: below `min` of the last `window` invites that
   * are at least `afterDays` old, once `minSample` of them exist. Messages carry on.
   */
  acceptRate?: { min: number; window: number; minSample: number; afterDays: number };
  /** How often each account is checked for accepts and for new messages, at random within. */
  pollEvery?: { acceptsHours: [number, number]; inboxMinutes: [number, number] };
  /** Rules a session writing for this channel follows, in plain sentences. */
  writing?: string[];
}

/**
 * LinkedIn, from what LinkedIn states and what outreach studies measured in 2025–2026
 * (docs/learnings.md, 2026-09-18): about 100 invites a week and under 20 a day; mornings in
 * the lead's zone are accepted more; the first message after an accept does best at 150 to
 * 200 characters with one question and no pitch; three messages beat one and five do worse;
 * acceptance under a quarter is what gets an account limited.
 */
const LINKEDIN: ChannelRules = {
  quietHours: [11, 7],
  perOp: [
    { ops: ["invite"], label: "invite", startPerDay: 10, maxPerDay: 20, perWeek: 100 },
    { ops: ["message"], label: "message", startPerDay: 20, maxPerDay: 50 },
    { ops: ["comment", "reply"], label: "comment", startPerDay: 10, maxPerDay: 30 },
  ],
  spacing: { minSec: 120, maxSec: 540 },
  perMinute: 1,
  perHour: 6,
  maxLength: { note: 200, message: 8000 },
  watchWindowHours: 96,
  withdrawAfterDays: 21,
  acceptRate: { min: 0.25, window: 50, minSample: 20, afterDays: 7 },
  pollEvery: { acceptsHours: [3, 5], inboxMinutes: [20, 40] },
  writing: [
    "A message after an accept is 150 to 200 characters: their situation in one line and one question they can answer in a line.",
    "No link and no pitch in the first message. The ask grows only after they answer.",
    "At most three messages to someone who has not answered, three to five days apart.",
    "Never open on their profile (\"I saw your profile\", \"great background\") or compliment them.",
    "One question per message. No lists, no bold, no emoji.",
    "Do not reuse one wording: two leads should rarely get the same sentence.",
  ],
};

const DEFAULTS: Partial<Record<ChannelKey, ChannelRules>> = { linkedin: LINKEDIN };

/** A channel's rules for one product: the defaults, with the product's overrides on top. */
export function rulesFor(channel: string, product?: Record<string, unknown> | null): ChannelRules {
  const base = DEFAULTS[channel as ChannelKey] ?? {};
  const own = ((product?.config as { channelRules?: Record<string, ChannelRules> } | undefined)?.channelRules ?? {})[channel];
  return { ...base, ...own };
}
