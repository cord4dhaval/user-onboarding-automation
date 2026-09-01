import { z } from "zod";
import { objectIdString } from "./common.js";

/**
 * A named group of people, built over the library and pointed at by a campaign.
 *
 * Static is a snapshot you picked. Dynamic is a saved filter that re-evaluates, so a
 * campaign aimed at one never runs out — a person becomes eligible on a Tuesday and gets
 * picked up on the next check without anyone scheduling it.
 */
export const audienceFilter = z.object({
  /** Days since the last message we sent them. */
  silentDays: z.number().int().nonnegative().optional(),
  /** Days since they last did anything at all. */
  quietDays: z.number().int().nonnegative().optional(),
  lifecycle: z.array(z.enum(["new", "active", "cooling", "dormant", "suppressed"])).optional(),
  segments: z.array(z.string()).optional(),
  stages: z.array(z.string()).optional(),
  temperature: z.array(z.enum(["hot", "warm", "cold", "dead"])).optional(),
  /** Has ever clicked, replied, or otherwise shown a positive signal. */
  everEngaged: z.boolean().optional(),
  /** Excludes anyone who has said no. Defaults on, and turning it off is deliberate. */
  excludeSuppressed: z.boolean().default(true),
  companyDomains: z.array(z.string()).optional(),
  minIcpFit: z.number().min(0).max(1).optional(),
});
export type AudienceFilter = z.infer<typeof audienceFilter>;

export const audience = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  name: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(["static", "dynamic"]),
  /** Static membership. Ignored for dynamic audiences. */
  personIds: z.array(objectIdString).default([]),
  filter: audienceFilter.optional(),
  createdBy: z.enum(["human", "claude"]).default("human"),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Audience = z.infer<typeof audience>;
