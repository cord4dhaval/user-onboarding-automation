import { z } from "zod";
import { channelKey, objectIdString } from "./common.js";

/**
 * Claude synthesises the plan; the engine executes it. Storing the plan as data rather
 * than code is what makes it fully dynamic without becoming unpredictable.
 */
export const planStep = z.object({
  id: z.number().int().positive(),
  when: z.string(),
  channel: channelKey,
  angle: z.string(),
  templateKey: z.string().optional(),
  cta: z.string().optional(),
  assetTier: z.enum(["A", "B", "C", "D"]).optional(),
  /** Present tense reasoning, kept so a human can audit why this step exists. */
  why: z.string(),
  gate: z.string().optional(),
  advanceIf: z.string().optional(),
  elseNext: z.number().int().positive().optional(),
});

export const plan = z.object({
  orgId: objectIdString,
  goalInstanceId: objectIdString,
  version: z.number().int().positive(),
  steps: z.array(planStep).min(1),
  onReply: z.string().default("pause; classify_intent; replan"),
  abortIf: z.array(z.string()).default([]),
  /** Why the previous version was abandoned. Across months this is the reasoning trail. */
  rationale: z.string(),
  createdBy: z.enum(["claude", "human"]),
  createdAt: z.date(),
});
export type Plan = z.infer<typeof plan>;
