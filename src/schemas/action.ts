import { z } from "zod";
import { channelKey, objectIdString, probability } from "./common.js";

/**
 * Every action commits to a falsifiable forecast before it is sent, then gets graded.
 * A single message does not cause a conversion — it shifts a probability — so predictions
 * are three-level and only the first is near-term certain.
 */
export const prediction = z.object({
  l1: z.record(z.string(), probability),
  l2: z.object({ advanceTo: z.string(), p: probability, byDays: z.number().int().positive() }),
  l3: z.object({ pBefore: probability, pIfPositive: probability, pIfSilent: probability }),
  windowClosesAt: z.date(),
});

export const acceptance = z.object({
  good: z.string(),
  ok: z.string(),
  bad: z.string(),
  kill: z.string(),
});

/**
 * The pre-declared branch table. The engine routes routine outcomes through this with no
 * model call at all; Claude is consulted only when reality falls outside every branch.
 * This is what makes a months-long loop affordable.
 */
export const branch = z.object({
  action: z.string(),
  when: z.string(),
  why: z.string().optional(),
});

export const composedContent = z.object({
  subject: z.string().optional(),
  preheader: z.string().optional(),
  bodyMd: z.string(),
  ctaText: z.string().optional(),
  ctaUrl: z.string().optional(),
  personalizationUsed: z.array(z.string()).default([]),
  /** Fed back to the composer so a later touch never repeats or contradicts an earlier one. */
  claimsMade: z.array(z.string()).default([]),
  wordCount: z.number().int().nonnegative(),
  /** The slot's prose on its own. `bodyMd` is the rendered message that wraps it. */
  slotText: z.string().optional(),
});

/** Touch, content, prediction and outcome in one document — one read tells the whole story. */
export const action = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  goalInstanceId: objectIdString,
  personId: objectIdString,
  planStepId: z.number().int().positive().optional(),
  channel: channelKey,
  channelId: objectIdString,
  templateId: objectIdString.optional(),
  angle: z.string(),
  content: composedContent,
  assetIds: z.array(objectIdString).default([]),
  rationale: z.string(),
  predict: prediction.optional(),
  accept: acceptance.optional(),
  next: z.record(z.string(), branch).default({}),

  /** Written to Mongo before the provider call and checked before the next — stops double-sends. */
  idempotencyKey: z.string(),
  // "dispatched" means the provider accepted it for later delivery; the reconciler moves
  // it to sent or failed once the provider says which.
  status: z
    // "held" is a paused campaign's queue, kept intact so resuming restores it rather than
    // losing the work; "skipped" is a decision that will not be revisited.
    .enum(["queued", "held", "awaiting_approval", "sending", "dispatched", "sent", "failed", "skipped"])
    .default("queued"),
  dueAt: z.date(),
  sentAt: z.date().optional(),
  providerMessageId: z.string().optional(),
  cost: z.number().nonnegative().default(0),

  /**
   * The dimensions an outcome is attributed to later.
   *
   * angle and channel already sit on the action; segment, step and hour are copied here at
   * send time because they all move afterwards. A rollup keyed on the person's segment as
   * it reads today would quietly rewrite the history of every message sent before they
   * were reclassified.
   */
  variant: z
    .object({
      segment: z.string().optional(),
      stepIndex: z.number().int().nonnegative().optional(),
      hourLocal: z.number().int().min(0).max(23).optional(),
      fitKnown: z.boolean().optional(),
    })
    .optional(),

  /**
   * Whether this message could report anything back.
   *
   * Without it, an untracked send and an ignored one are the same document, and the angle
   * gets blamed for silence that was really a missing pixel. Only messages that could have
   * reported a click belong in a click-rate.
   */
  tracking: z
    .object({ opens: z.boolean(), clicks: z.boolean() })
    .default({ opens: false, clicks: false }),

  signals: z.array(z.object({ type: z.string(), at: z.date() })).default([]),
  /** Denormalised from signals so "who clicked" is an index hit rather than an array scan. */
  firstOpenedAt: z.date().optional(),
  firstClickedAt: z.date().optional(),
  /** The strongest signal of all, and the only one that arrives in words. */
  firstRepliedAt: z.date().optional(),
  outcome: z.object({
    grade: z.enum(["good", "ok", "bad", "kill"]),
    brier: z.number().optional(),
    l2Advanced: z.boolean(),
    learnNote: z.string().optional(),
    gradedAt: z.date(),
  }).optional(),
});
export type Action = z.infer<typeof action>;
