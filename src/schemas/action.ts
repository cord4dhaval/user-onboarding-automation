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
  /**
   * What this message asks for: a reply, or a click.
   *
   * "reply" suppresses the template's button, so the only thing to do is answer. The first
   * touches of a sequence ask that way — a stranger who has read four sentences is being
   * asked for a trial, which is the largest ask we have and the one fewest people take.
   */
  ask: z.enum(["reply", "link"]).optional(),
  /** Cost lines and short list lines a session wrote for a frame that lays them out. */
  parts: z
    .object({
      cost: z.object({ title: z.string().optional(), rows: z.array(z.object({ label: z.string(), value: z.string() })) }).optional(),
      shows: z.object({ title: z.string().optional(), items: z.array(z.string()) }).optional(),
    })
    .optional(),
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
  /**
   * The idea this touch was built on, in words a person reads ("Evening status calls").
   * Written by a session under the rolling planner; `angle` carries its slug so every
   * rollup keyed on angle keeps working.
   */
  theme: z.string().optional(),
  /** How the idea is delivered: story, rupee_math, question, comparison, proof, or another. */
  hook: z.string().optional(),
  /**
   * Plain text, designed, a letter (HTML that looks typed), or a picture mail (template 4: the
   * picture carries the findings, the text only what they cost). Read at send and outranks
   * the template's own format.
   */
  format: z.enum(["text", "html", "letter", "picture"]).optional(),
  /** The picture a template-4 mail was written around. See engine/picture.ts. */
  picture: z.object({ key: z.string(), url: z.string().url(), alt: z.string(), bg: z.string() }).optional(),
  formatWhy: z.string().optional(),
  /** The idea-bank numbers the touch was built on, copied from its plan step, for learning by idea. */
  ideaRefs: z.array(z.number()).optional(),
  /** How the touch is laid out: story, cost_box, checklist or cost_and_list. Learned on like format. */
  layout: z.string().optional(),
  /**
   * Render through this template key rather than the one the plan step names. Set when the
   * engine falls back to a fixed email because the written one never arrived; a family key
   * picks the member this person has not had.
   */
  templateKey: z.string().optional(),
  /** Queued by the campaign's firstTouch at arrival; read at send for schedule.firstTouchApproval. */
  firstTouch: z.boolean().optional(),
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
  /**
   * What kind of LinkedIn action this went out as: an invite, a message, a comment or a
   * reply. Written at send, and what the per-action limits count.
   */
  op: z.enum(["invite", "message", "comment", "reply"]).optional(),
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
      /**
       * What the message carried, frozen like everything else here.
       *
       * `assetKey` is the field rollups group on and is null unless exactly one asset rode
       * along: grouping on a list would fold "the demo" and "the demo plus a case study"
       * into one bucket while appearing to have separated them. `assetKeys` keeps the whole
       * truth for reading a single message back.
       */
      assetKey: z.string().nullable().optional(),
      assetKeys: z.array(z.string()).optional(),
      assetTier: z.enum(["A", "B", "C", "D"]).nullable().optional(),
      /** The rolling planner's labels, frozen here for the same reason the segment is. */
      theme: z.string().nullable().optional(),
      hook: z.string().nullable().optional(),
      format: z.enum(["text", "html", "letter", "picture"]).optional(),
      ask: z.enum(["reply", "link"]).optional(),
      /** segment|team size band, the unit results are compared across. */
      group: z.string().optional(),
      layout: z.string().optional(),
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
  /** The open was read off a click, not seen by the pixel. */
  openInferred: z.boolean().optional(),
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
