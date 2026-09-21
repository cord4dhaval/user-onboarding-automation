/**
 * How long to leave between touches, decided by what the person has actually done.
 *
 * The campaign already carried a `cadenceByTemp` table and nothing read it. It was handed
 * to Claude as advice in a prompt, which means it held exactly as long as a model chose to
 * respect it, and the numbers in it were backwards: the hot band was given a two-to-four
 * day gap and the cold band one-to-two, so a person who had just clicked waited longer than
 * one who had ignored five emails — while the monitoring prompt told Claude the opposite,
 * to tighten a sequence when somebody goes hot.
 *
 * The corrected reading is the obvious one. Attention is perishable. Someone who clicked an
 * hour ago is available now and will not be next week; someone who has read nothing needs
 * space, not persistence, because the alternative to a wider gap is a spam complaint.
 */

export interface CadenceBand {
  minGapDays: number;
  maxGapDays: number;
}

export const DEFAULT_CADENCE: Record<string, CadenceBand> = {
  // A quarter of a day. They are reading their inbox right now.
  hot: { minGapDays: 0.25, maxGapDays: 1 },
  warm: { minGapDays: 2, maxGapDays: 3 },
  // Wider than the plan usually asks for. Silence is an answer, and crowding it produces
  // complaints rather than replies.
  cold: { minGapDays: 3, maxGapDays: 5 },
  dead: { minGapDays: 999, maxGapDays: 999 },
};

const DAY_MS = 86_400_000;

/**
 * The least time between two messages to one person on different channels, by the band
 * they are paced at.
 *
 * The campaign's gap is counted per channel: a WhatsApp intro is not held for two days
 * because an email went yesterday, or it would never go to a lead whose email campaign
 * writes every day. But an email and a WhatsApp landing in the same minute read as one
 * sender who cannot decide, so any two messages are still kept apart. One fixed two hours
 * (2026-09-21) was too slow for someone who filled in our form a minute ago, who expects an
 * email and a WhatsApp together, and too quick for a stranger, who reads a WhatsApp two
 * hours after a cold email as being chased.
 */
const CROSS_CHANNEL_GAP: Record<string, { ms: number; label: string }> = {
  hot: { ms: 15 * 60_000, label: "15 minutes" },
  warm: { ms: 2 * 3_600_000, label: "2 hours" },
  cold: { ms: DAY_MS, label: "1 day" },
};

/** A person with no band yet, or gone dead, keeps the old two hours. */
export function crossChannelGap(band: string | undefined): { ms: number; label: string } {
  return CROSS_CHANNEL_GAP[band ?? ""] ?? CROSS_CHANNEL_GAP.warm!;
}

export function bandFor(
  band: string | undefined,
  configured?: Record<string, CadenceBand> | undefined,
): CadenceBand {
  const key = band && DEFAULT_CADENCE[band] ? band : "cold";
  const fromGoal = configured?.[key];
  // A campaign may widen or tighten its own bands, but an incomplete table falls back
  // per-band rather than wholesale: a goal that names only "hot" still gets sane numbers
  // for the other three.
  return {
    minGapDays: fromGoal?.minGapDays ?? DEFAULT_CADENCE[key]!.minGapDays,
    maxGapDays: fromGoal?.maxGapDays ?? DEFAULT_CADENCE[key]!.maxGapDays,
  };
}

export interface DueAtInput {
  /** What the plan asked for, in days after the previous touch. */
  offsetDays: number;
  band?: string;
  lastContactedAt?: Date | string | null;
  configured?: Record<string, CadenceBand>;
  now?: Date;
}

/**
 * When a step should actually fire.
 *
 * The plan's offset is an intention, not a date. It was written when the person was cold
 * and unread, and holding it as a fixed timestamp is why a click at two o'clock changed a
 * temperature, a score and a band, and then changed nothing the recipient could see: their
 * next message still sat where it had been put four days earlier.
 *
 * Computing it from the last contact instead means a plan written a fortnight ago still
 * paces correctly today, and a person who warms up moves without anything having to rewrite
 * their plan.
 */
export function dueAtFor(input: DueAtInput): Date {
  const now = input.now ?? new Date();
  const band = bandFor(input.band, input.configured);
  if (band.minGapDays >= 999) {
    // Dead. Far enough out that nothing fires; the campaign will be closed by verification
    // long before this date, and a date is easier to reason about than a null.
    return new Date(now.getTime() + 365 * DAY_MS);
  }

  // A gap is the space between two messages. With no previous message there is nothing to
  // space this one from, and applying the band anyway delays a first contact for a reason
  // that does not exist — which is exactly what happened to ninety-eight people whose
  // welcome had failed: they had never received anything, and the cold band pushed their
  // first-ever email three days into the future.
  if (!input.lastContactedAt) return now;

  const gapDays = Math.min(Math.max(input.offsetDays, band.minGapDays), band.maxGapDays);
  const anchor = new Date(String(input.lastContactedAt));
  const due = new Date(anchor.getTime() + gapDays * DAY_MS);
  // Never in the past. A plan whose early steps have already elapsed should send its next
  // message now, not fire three of them at once to catch up.
  return due < now ? now : due;
}

/**
 * When this person last heard from us on one channel.
 *
 * The campaign's gap is counted per channel, because a lead can be in an email campaign and
 * a WhatsApp one at once: counted across both, the WhatsApp message waits out every email's
 * gap and never goes to a lead whose email campaign writes daily. Sends from before the
 * per-channel record existed were all email; they were copied into contactedOn.email on
 * 2026-09-18, and a person with no record at all still reads the old single field.
 */
export function lastOnChannel(person: Record<string, unknown> | null | undefined, channel: string): Date | undefined {
  const byChannel = person?.contactedOn as Record<string, unknown> | undefined;
  // The old field only for someone with no per-channel record at all. Once there is one, a
  // missing channel means never contacted there: reading lastContactedAt then would time an
  // email's wait from the WhatsApp message that went since.
  const value = byChannel ? byChannel[channel] : channel === "email" ? person?.lastContactedAt : undefined;
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}
