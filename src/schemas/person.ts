import { z } from "zod";
import { lifecycleStage, objectIdString, temperatureBand } from "./common.js";

/**
 * Belief is the salesperson's mental model made explicit and updatable. It is derived
 * state: a human who disagrees submits a correction (recorded as an event and as training
 * signal) rather than overwriting the field.
 */
export const belief = z.object({
  segment: z.string(),
  confidence: z.number().min(0).max(1),
  useCase: z.string().optional(),
  painHypothesis: z.string().optional(),
  objectionsLikely: z.array(z.string()).default([]),
  blocker: z.string().optional(),
  icpFit: z.number().min(0).max(1),
  intentScore: z.number(),
  reasoning: z.string(),
  source: z.enum(["system", "human"]).default("system"),
  updatedAt: z.date(),
});

export const temperature = z.object({
  score: z.number(),
  band: temperatureBand,
  computedAt: z.date(),
  /** Which inputs were actually available — a channel without open tracking drops that term. */
  termsUsed: z.array(z.string()),
});

export const identity = z.object({
  kind: z.enum(["email", "phone", "linkedin", "product_uid"]),
  value: z.string(),
  verified: z.boolean().default(false),
});

export const person = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  identities: z.array(identity).min(1),
  primaryEmail: z.string().email().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  companyDomain: z.string().optional(),
  enrichment: z.record(z.string(), z.unknown()).optional(),
  timezone: z.string().default("UTC"),
  language: z.string().default("en"),
  stage: lifecycleStage.default("lead"),
  consent: z.object({
    state: z.enum(["opt_in", "legitimate_interest", "withdrawn"]),
    capturedAt: z.date(),
    evidence: z.string().optional(),
  }),
  suppressedAt: z.date().optional(),
  belief: belief.optional(),
  temp: temperature.optional(),
  sourceId: objectIdString.optional(),
  /** Set on ingest, cleared once Claude has classified and planned. */
  needsClassification: z.boolean().default(true),
  createdAt: z.date(),
});
export type Person = z.infer<typeof person>;
