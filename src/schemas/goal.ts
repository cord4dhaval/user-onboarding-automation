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

  failure: z.object({
    conditions: z.array(z.string()),
    silenceDays: z.number().int().positive(),
  }),

  budget: z.object({
    touches: z.number().int().positive(),
    days: z.number().int().positive(),
    usd: z.number().nonnegative(),
  }),

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
