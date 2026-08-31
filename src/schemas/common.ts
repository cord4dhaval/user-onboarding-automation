import { z } from "zod";

/** Every document in the system is scoped to an organization (the tenant boundary). */
export const objectIdString = z.string().regex(/^[0-9a-f]{24}$/, "expected an ObjectId hex string");

export const tenantScoped = z.object({
  orgId: objectIdString,
  productId: objectIdString,
});

export const channelKey = z.enum(["email", "whatsapp", "sms", "in_app", "linkedin", "push"]);
export type ChannelKey = z.infer<typeof channelKey>;

export const temperatureBand = z.enum(["hot", "warm", "cold", "dead"]);
export type TemperatureBand = z.infer<typeof temperatureBand>;

export const lifecycleStage = z.enum([
  "lead",
  "trial_started",
  "activated",
  "paying",
  "dormant",
  "churned",
]);

/** How a connection authenticates. The same three shapes serve sources and channels. */
export const authType = z.enum([
  "api_key",
  "oauth2",
  "smtp",
  "bearer",
  "mcp_oauth",
  "mcp_bearer",
  "mcp_stdio",
]);
export type AuthType = z.infer<typeof authType>;

export const connectionStatus = z.enum([
  "pending",
  "verifying",
  "provisioning",
  "warming",
  "healthy",
  "degraded",
  "expired",
  "revoked",
  "disabled",
]);

export const money = z.number().nonnegative();
export const probability = z.number().min(0).max(1);

/**
 * A derived value that a human may override. The override is recorded rather than
 * applied destructively, so the correction survives as training signal.
 */
export function overridable<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    value: inner,
    source: z.enum(["system", "human"]).default("system"),
    reason: z.string().optional(),
    expiresAt: z.date().optional(),
    updatedAt: z.date(),
  });
}
