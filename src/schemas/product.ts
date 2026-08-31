import { z } from "zod";
import { channelKey, objectIdString } from "./common.js";

/**
 * Everything product-specific lives here. The engine, planner, composer and adapters
 * contain no knowledge of any particular product — adding one is this document plus a
 * set of connections, which is the whole generic claim.
 */

export const segment = z.object({
  key: z.string(),
  name: z.string(),
  /** How to recognise this person from enrichment. Claude reads it; humans edit it. */
  detect: z.string(),
  useCase: z.string(),
  pain: z.string(),
  objections: z.array(z.string()).default([]),
  /** Ordered by expected response for this persona, not by what is cheapest. */
  preferredChannels: z.array(channelKey).default(["email"]),
});

export const productConfig = z.object({
  website: z.string().url().optional(),
  oneLiner: z.string(),
  valueProps: z.array(z.string()).min(1),
  segments: z.array(segment).default([]),

  /**
   * Behavioural, not administrative. Signup is not activation, and an activated trial
   * converts several times better than an inactive one — so this is what goals aim at.
   */
  activation: z.object({
    describedAs: z.string(),
    events: z.array(z.string()).default([]),
  }),

  voice: z.object({
    tone: z.string(),
    do: z.array(z.string()).default([]),
    dont: z.array(z.string()).default([]),
    readingLevel: z.number().int().min(4).max(14).default(8),
  }),

  constraints: z.object({
    maxTouchesPerWeek: z.number().int().positive().default(2),
    quietHours: z.tuple([z.number().int(), z.number().int()]).default([21, 8]),
    forbiddenClaims: z.array(z.string()).default([]),
  }),

  /** What the product wants connected. Suggestions only — the user authorises each one. */
  suggestedChannels: z.array(z.object({
    key: channelKey,
    why: z.string(),
    priority: z.number().int().positive(),
  })).default([]),

  trialLinkTemplate: z.string().default("https://example.com/start?p={{person_id}}"),
});
export type ProductConfig = z.infer<typeof productConfig>;

export const product = z.object({
  orgId: objectIdString,
  slug: z.string(),
  name: z.string(),
  config: productConfig,
  version: z.number().int().positive().default(1),
  status: z.enum(["draft", "active", "paused"]).default("draft"),
  createdAt: z.date(),
});
export type Product = z.infer<typeof product>;
