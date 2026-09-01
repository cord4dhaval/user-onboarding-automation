import { z } from "zod";
import { channelKey, objectIdString, temperatureBand } from "./common.js";

/**
 * A goal is a named terminal state with entry conditions, explicit success AND failure
 * criteria, and a budget. All four are mandatory: without failure conditions and a budget,
 * "keep pushing until we achieve our goal" degenerates into harassment.
 */
export const goal = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  key: z.string(),
  name: z.string(),

  entry: z.object({
    expression: z.string(),
    minIcpFit: z.number().min(0).max(1).default(0),
  }),

  /** Behavioural, not administrative. Signup is not a goal; activation is. */
  success: z.object({
    expression: z.string(),
    describedAs: z.string(),
  }),

  /**
   * How the engine finds out whether someone succeeded.
   *
   * Claude writes these when the goal is created: it reads the plain-words success
   * sentence, reads whatever verifiers are connected, and proposes a tool and an
   * assertion for each thing that has to be true. The engine then runs them forever
   * without a model.
   *
   * A goal with no checks cannot tell when it has succeeded, which is why creating one
   * without them is refused rather than allowed to fail quietly thirty days later.
   */
  checks: z.array(z.object({
    key: z.string(),
    /** What this proves, in the words a person would use. */
    describedAs: z.string(),
    connectionId: objectIdString,
    tool: z.string(),
    args: z.record(z.string(), z.string()).default({}),
    /** Evaluated against the tool's response; true means this check has passed. */
    assert: z.string(),
    /** Once true, never asked again — settled facts do not need re-checking. */
    latch: z.boolean().default(true),
    proposedBy: z.enum(["claude", "human"]).default("claude"),
  })).default([]),

  failure: z.object({
    conditions: z.array(z.string()),
    silenceDays: z.number().int().positive(),
  }),

  budget: z.object({
    touches: z.number().int().positive(),
    days: z.number().int().positive(),
    usd: z.number().nonnegative(),
  }),

  /**
   * Every channel this campaign may reach for. Claude plans within this set and never
   * outside it, so a campaign meant for email alone cannot quietly start sending WhatsApp.
   */
  allowedChannels: z.array(channelKey).min(1),

  /** Fires immediately on entry, deterministically, without waiting for a Claude session. */
  firstTouch: z.object({
    templateKey: z.string(),
    /** Priority chain — the first healthy, consented channel wins. Never all at once. */
    channels: z.array(channelKey).min(1),
  }),

  /** The clock lives in the goal. Nothing in the engine hardcodes an interval. */
  schedule: z.object({
    fetchEverySec: z.number().int().positive(),
    tickEverySec: z.number().int().positive(),
    quietHours: z.tuple([z.number().int(), z.number().int()]).optional(),
    bufferDepth: z.number().int().positive().default(3),
    approvalMode: z.enum(["gate_on", "auto_below_risk", "auto_send"]).default("gate_on"),
  }),

  /** Cadence widens as a lead cools. Cold gets more variety, never more volume. */
  cadenceByTemp: z.record(temperatureBand, z.object({
    minGapDays: z.number().positive(),
    maxGapDays: z.number().positive(),
    maxAssetTier: z.enum(["A", "B", "C", "D"]),
  })),

  sourceIds: z.array(objectIdString).default([]),
  /** Reached on success; goals chain rather than overlap. */
  nextGoalKey: z.string().optional(),
  enabled: z.boolean().default(true),
});
export type Goal = z.infer<typeof goal>;

export const goalInstance = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  personId: objectIdString,
  goalKey: z.string(),
  status: z.enum(["active", "succeeded", "failed", "recycled", "paused"]).default("active"),
  spent: z.object({
    touches: z.number().int().nonnegative().default(0),
    usd: z.number().nonnegative().default(0),
  }),
  deadline: z.date(),
  nextTickAt: z.date(),
  currentPlanId: objectIdString.optional(),
  startedAt: z.date(),
  endedAt: z.date().optional(),
  outcome: z.string().optional(),
});
export type GoalInstance = z.infer<typeof goalInstance>;
