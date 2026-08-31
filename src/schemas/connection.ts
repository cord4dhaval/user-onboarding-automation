import { z } from "zod";
import { authType, connectionStatus, objectIdString } from "./common.js";

/**
 * A connection is authentication plus discovered capability. It is direction-agnostic:
 * the same connection can feed leads in (a source) and send messages out (a channel).
 */
export const connection = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  key: z.string(),
  provider: z.string(),
  authType,
  /** Present for MCP connections. */
  serverUrl: z.string().url().optional(),
  protocolVersion: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  status: connectionStatus.default("pending"),
  directions: z.array(z.enum(["in", "out"])).min(1),
  lastVerifiedAt: z.date().optional(),
  createdBy: objectIdString,
  createdAt: z.date(),
});
export type Connection = z.infer<typeof connection>;

/**
 * Secrets live in their own collection under envelope encryption. Nothing here is ever
 * returned by an MCP tool — the engine resolves credentials at send time, in process.
 */
export const credential = z.object({
  orgId: objectIdString,
  connectionId: objectIdString,
  authType,
  ciphertext: z.string(),
  encDek: z.string(),
  keyVersion: z.number().int(),
  nonce: z.string(),
  expiresAt: z.date().optional(),
  refreshAfter: z.date().optional(),
  status: z.enum(["pending", "verified", "degraded", "expired", "revoked"]).default("pending"),
  lastUsedAt: z.date().optional(),
  rotatedAt: z.date().optional(),
});
export type Credential = z.infer<typeof credential>;

/**
 * Capability values carry their provenance. "declared" comes from the server itself,
 * "inferred" from reading its tool schemas, "probed" from a live test.
 *
 * Anything unconfirmed defaults to false. Assuming a signal exists when it does not
 * corrupts temperature scoring silently, which is the worst failure mode in the system.
 */
export const capabilityValue = z.object({
  value: z.union([z.boolean(), z.string(), z.number()]),
  source: z.enum(["declared", "inferred", "probed", "human"]),
  confidence: z.number().min(0).max(1),
  verifiedAt: z.date(),
});

export const mcpBinding = z.object({
  orgId: objectIdString,
  connectionId: objectIdString,
  /** Maps our adapter verbs onto whatever the server actually named its tools. */
  bind: z.record(
    z.string(),
    z.object({
      tool: z.string(),
      args: z.record(z.string(), z.string()),
      returns: z.record(z.string(), z.string()).optional(),
      healthyIf: z.string().optional(),
    }),
  ),
  capabilities: z.record(z.string(), capabilityValue),
  toolsHash: z.string(),
  discoveredAt: z.date(),
  confirmedBy: objectIdString.optional(),
  lastProbeAt: z.date().optional(),
});
export type McpBinding = z.infer<typeof mcpBinding>;
