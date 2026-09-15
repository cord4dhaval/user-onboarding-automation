/**
 * A message skipped because the plan it was written for was replaced.
 *
 * Both writers — a playbook stamp and Claude's per-lead plan — start the reason with these
 * words. Such a message did not fail: the new plan's own step took its place. Listed as
 * undelivered it read as an error, and returned to review it would send the old template
 * alongside the new plan's message.
 */
export const REPLACED_PLAN = /^plan replaced/;

export const isReplacedPlan = (reason: unknown): boolean => REPLACED_PLAN.test(String(reason ?? ""));
