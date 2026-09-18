import type { Document } from "mongodb";

/**
 * Campaigns that run beside a lead's main campaign.
 *
 * A person is in one active campaign at a time. The rule exists because two plans writing to
 * one human read as two strangers who never spoke to each other. A channel campaign fed by
 * the same source is the case it got wrong: TeamGrid's hot leads arrive once, through one
 * lead tool, and are held by the email campaign — so a WhatsApp intro campaign on the same
 * tool enrolled none of them, and every new lead went to whichever of the two polled first.
 *
 * A campaign marked `alongside` may enrol a lead the main campaign already holds, provided
 * the main campaign does not use any channel the alongside one does. The two then never
 * write on the same channel, and the main campaign stays the one that plans, answers
 * replies, reads signals and is shown on the lead card: every lookup of "the lead's
 * campaign" filters with MAIN_ONLY.
 */

/** Query fragment for goal instances that are a lead's main campaign. */
export const MAIN_ONLY = { alongside: { $ne: true } } as const;

/**
 * The people an arrival must not start this campaign for, given the campaigns they already
 * have open.
 *
 * - A main campaign is blocked only by another main campaign; alongside ones never count.
 * - An alongside campaign is blocked by itself, and by a main campaign that already uses one
 *   of its channels — that campaign reaches the lead there already, and a second message on
 *   the same channel from a different plan is exactly what the one-campaign rule prevents.
 */
export function blockedPeople(
  goal: { key: string; alongside?: boolean; allowedChannels?: string[] },
  open: Document[],
  goalsByKey: Map<string, Document>,
): Set<string> {
  const blocked = new Set<string>();
  const mine = new Set(goal.allowedChannels ?? ["email"]);

  for (const instance of open) {
    const personId = String(instance.personId);
    const isAlongside = instance.alongside === true;

    if (!goal.alongside) {
      if (!isAlongside) blocked.add(personId);
      continue;
    }

    if (String(instance.goalKey) === goal.key) {
      blocked.add(personId);
      continue;
    }
    if (isAlongside) continue;
    const theirs = (goalsByKey.get(String(instance.goalKey))?.allowedChannels ?? ["email"]) as string[];
    if (theirs.some((channel) => mine.has(channel))) blocked.add(personId);
  }
  return blocked;
}
