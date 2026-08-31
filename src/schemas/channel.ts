import { z } from "zod";
import { channelKey, connectionStatus, objectIdString } from "./common.js";

/**
 * Capabilities drive the planner: a channel that cannot report opens is never given an
 * angle that depends on open-rate feedback, and a channel that cannot carry an asset
 * never receives a plan step that attaches one.
 */
export const channelCapabilities = z.object({
  send: z.boolean().default(true),
  html: z.boolean().default(false),
  attachments: z.boolean().default(false),
  richTypes: z.array(z.string()).default([]),
  maxLength: z.number().int().positive().optional(),
  trackingOpens: z.boolean().default(false),
  trackingClicks: z.boolean().default(false),
  bounceWebhook: z.boolean().default(false),
  inboundReplies: z.boolean().default(false),
  consentRequired: z.boolean().default(false),
  /** WhatsApp-style rules: free-form only inside a reply window, templates outside it. */
  windowRules: z.string().optional(),
  fromDomain: z.enum(["caller_controlled", "controlled_by_provider"]).default("controlled_by_provider"),
  costPerMsg: z.number().nonnegative().default(0),
  rateLimit: z.string().optional(),
  /** Hard caps the provider enforces; the validator rejects anything over them. */
  maxSubjectLength: z.number().int().positive().optional(),
  maxBodyLength: z.number().int().positive().optional(),
  /** True where the provider queues and the outcome must be polled afterwards. */
  asyncDelivery: z.boolean().default(false),
});

/** Warmup and daily caps are enforced in code, never left to the planner's discretion. */
export const sendGovernor = z.object({
  dailyCap: z.number().int().nonnegative(),
  perMinute: z.number().int().positive().optional(),
  perHour: z.number().int().positive().optional(),
  warmupDay: z.number().int().nonnegative().default(0),
  sentToday: z.number().int().nonnegative().default(0),
  windowStartedAt: z.date(),
});

export const channel = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  connectionId: objectIdString,
  key: channelKey,
  kind: z.enum(["native", "mcp"]),
  from: z.string().optional(),
  capabilities: channelCapabilities,
  governor: sendGovernor,
  /**
   * Which audiences this channel may serve. Cold outbound belongs on an isolated
   * sending identity; existing users belong on the product's own established one.
   */
  policy: z.object({
    audience: z.array(z.enum(["cold", "warm_lead", "existing_user"])).default(["cold", "warm_lead", "existing_user"]),
    quietHours: z.tuple([z.number().int(), z.number().int()]).optional(),
  }),
  fallbackChannelKey: channelKey.optional(),
  status: connectionStatus.default("pending"),
  enabled: z.boolean().default(true),
});
export type Channel = z.infer<typeof channel>;
