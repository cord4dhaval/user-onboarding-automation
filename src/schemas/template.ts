import { z } from "zod";
import { channelKey, objectIdString, temperatureBand } from "./common.js";

/**
 * Templates are skeletons with slots, not stored copy. The human owns structure, assets
 * and offer; Claude fills the slots per person. Pure generation is uncontrollable and
 * pure templates are dead mail.
 */
export const block = z.discriminatedUnion("type", [
  // A first touch fires within seconds of a lead landing, before any Claude session has
  // run. Slots therefore carry a deterministic fallback so the welcome can be rendered
  // without a model; later touches replace it with composed copy.
  z.object({ type: z.literal("subject"), slot: z.string(), fallback: z.string().optional() }),
  z.object({ type: z.literal("text"), fixed: z.string() }),
  z.object({ type: z.literal("slot"), instruct: z.string(), fallback: z.string().optional() }),
  z.object({
    type: z.literal("asset"),
    tier: z.enum(["A", "B", "C", "D"]),
    ref: z.string().optional(),
    template: z.string().optional(),
    data: z.array(z.string()).optional(),
    maxCost: z.number().nonnegative().default(0),
    /** A missing or over-budget asset must never block the touch. */
    fallback: z.literal("text_only"),
  }),
  z.object({ type: z.literal("cta"), fixed: z.string(), url: z.string() }),
  z.object({ type: z.literal("system"), fixed: z.enum(["opt_out_block"]) }),
]);

export const template = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  key: z.string(),
  channel: channelKey,
  stage: z.string(),
  temp: temperatureBand.optional(),
  /** Resolution is a cascade: person override beats segment beats product default. */
  scope: z.enum(["product_default", "segment", "person_override"]),
  segmentKey: z.string().optional(),
  personId: objectIdString.optional(),
  version: z.number().int().positive().default(1),
  parentId: objectIdString.optional(),
  blocks: z.array(block).min(1),
  constraints: z.object({
    maxWords: z.number().int().positive().optional(),
    readingLevel: z.number().int().positive().optional(),
    noClaims: z.array(z.string()).default([]),
  }),
  assetIds: z.array(objectIdString).default([]),
  stats: z.object({
    sent: z.number().int().nonnegative().default(0),
    replied: z.number().int().nonnegative().default(0),
    converted: z.number().int().nonnegative().default(0),
    alpha: z.number().default(1),
    beta: z.number().default(1),
  }),
  embedding: z.array(z.number()).optional(),
  status: z.enum(["draft", "active", "paused"]).default("draft"),
  createdBy: z.enum(["claude", "human"]),
});
export type Template = z.infer<typeof template>;
