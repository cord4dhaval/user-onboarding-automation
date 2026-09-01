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

/**
 * Where a person came from, every time. Three arrivals is itself a signal — that person
 * keeps circling — and a single sourceId could never say so.
 */
export const arrival = z.object({
  sourceId: objectIdString.optional(),
  kind: z.string(),
  at: z.date(),
  detail: z.string().optional(),
});

/**
 * What has been spent on this one person, across everything. Sends, enrichment, generated
 * assets and model time all land here, so the cost of pursuing someone is answerable.
 */
export const investment = z.object({
  messages: z.number().int().nonnegative().default(0),
  usd: z.number().nonnegative().default(0),
  enrichmentCalls: z.number().int().nonnegative().default(0),
  assetsGenerated: z.number().int().nonnegative().default(0),
  campaignsRun: z.number().int().nonnegative().default(0),
});

/**
 * Where a person sits between campaigns.
 *
 * new         never contacted
 * active      a campaign is working on them right now
 * cooling     an attempt ended; they may be approached again after coolingUntil
 * dormant     several attempts spent, resting for a long while
 * suppressed  they said no. Permanent, and no campaign may ever pick them up.
 */
export const lifecycleState = z.enum(["new", "active", "cooling", "dormant", "suppressed"]);

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
  arrivals: z.array(arrival).default([]),

  lifecycle: lifecycleState.default("new"),
  /** Set when an attempt ends. Nothing may contact them before this passes. */
  coolingUntil: z.date().optional(),
  attempts: z.number().int().nonnegative().default(0),
  /** Accumulated across every campaign, so attempt two knows what attempt one heard. */
  objections: z.array(z.object({ text: z.string(), at: z.date(), source: z.string() })).default([]),
  investment: investment.default({}),
  lastContactedAt: z.date().optional(),
  lastSignalAt: z.date().optional(),

  /** Set on ingest, cleared once Claude has classified and planned. */
  needsClassification: z.boolean().default(true),
  createdAt: z.date(),
});
export type Person = z.infer<typeof person>;
