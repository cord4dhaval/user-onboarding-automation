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
  /**
   * What the engine refuses, so the writing rules hold whatever a session does. Characters
   * per message: the first after an accept, a later one, and an answer to their reply.
   */
  targetChars?: { first: [number, number]; later: [number, number]; answer: [number, number] };
  /** Days before a message: the first after an accept, and each one after that. */
  gapDays?: { first: [number, number]; later: [number, number] };
  /** Messages to someone who has not answered, in total. */
  maxUnanswered?: number;
  /** Phrases refused in any message, as case-insensitive patterns: the tells of automated outreach. */
  banned?: string[];
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
  targetChars: { first: [120, 220], later: [60, 300], answer: [20, 450] },
  gapDays: { first: [0, 2], later: [3, 5] },
  maxUnanswered: 3,
  banned: [
    "(came across|saw|looked at|viewed|checked out) your profile",
    "impressive (background|profile|journey|experience)",
    "hope (this|my) (message )?finds you",
    "hope you are (doing )?well",
    "i wanted to reach out",
    "quick question",
    "touch base",
    "pick your brain",
    "\\b(you|your team) (clicked|filled|signed up|asked)",
    "your form",
    // A band read straight off a form ("11 to 50", "51-200") is how a record talks, not a person.
    "\\b\\d{1,4}\\s*(to|-|\u2013)\\s*\\d{1,4}\\b",
  ],
  writing: [
    "A message after an accept is 150 to 200 characters: one plain clause saying what the product is and does, their situation in one line, and one question they can answer in a line.",
    "Say what the product is in the first message. The invite carried no note, so they know nothing about us, and a message that never says who we are reads as a stranger's.",
    "No link and no pitch in the first message; naming the product and what it does is not a pitch. The ask grows only after they answer.",
    "Say numbers the way a person says them. Never read a form's own words back to them, such as a team-size band.",
    "At most three messages to someone who has not answered, three to five days apart.",
    "Never open on their profile (\"I saw your profile\", \"great background\") or compliment them.",
    "One question per message. No lists, no bold, no emoji.",
    "Do not reuse one wording: two leads should rarely get the same sentence.",
  ],
};

const DEFAULTS: Partial<Record<ChannelKey, ChannelRules>> = { linkedin: LINKEDIN };

/**
 * A channel's rules for one product: the defaults, with the product's overrides on top.
 *
 * `banned` is the exception: the two lists are added, not replaced. A product's list is its
 * own voice ("no contractions"), and a product that copied the defaults once went on using
 * that stale copy, so a phrase added to the channel later reached nobody.
 */
export function rulesFor(channel: string, product?: Record<string, unknown> | null): ChannelRules {
  const base = DEFAULTS[channel as ChannelKey] ?? {};
  const own = ((product?.config as { channelRules?: Record<string, ChannelRules> } | undefined)?.channelRules ?? {})[channel];
  const merged = { ...base, ...own };
  if (base.banned || own?.banned) merged.banned = [...new Set([...(base.banned ?? []), ...(own?.banned ?? [])])];
  return merged;
}
