import { z } from "zod";
import { channelKey, objectIdString, temperatureBand } from "./common.js";

/**
 * Templates are skeletons with slots, not stored copy. The human owns structure, assets
 * and offer; Claude fills the slots per person. Pure generation is uncontrollable and
 * pure templates are dead mail.
 *
 * Blocks carry no styling. Appearance comes from the product's brand kit at render time,
 * which is what lets one template look right for every tenant and lets a brand refresh
 * restyle every template without touching one of them.
 */
export const block = z.discriminatedUnion("type", [
  // A first touch fires within seconds of a lead landing, before any Claude session has
  // run. Slots therefore carry a deterministic fallback so the welcome can be rendered
  // without a model; later touches replace it with composed copy.
  z.object({ type: z.literal("subject"), slot: z.string(), fallback: z.string().optional() }),

  /**
   * The grey line the inbox shows beside the subject. Invisible in the body itself.
   * After the subject line it is the largest open-rate lever there is, so it gets a block
   * rather than being derived from the first sentence.
   */
  z.object({ type: z.literal("preheader"), slot: z.string().optional(), fallback: z.string().optional() }),

  z.object({ type: z.literal("text"), fixed: z.string() }),

  /**
   * `name` lets one template hold several independently written sections. Unnamed slots
   * keep the original behaviour of taking the composed body wholesale.
   */
  z.object({
    type: z.literal("slot"),
    name: z.string().optional(),
    instruct: z.string(),
    fallback: z.string().optional(),
  }),

  z.object({
    type: z.literal("heading"),
    level: z.number().int().min(1).max(3).default(1),
    fixed: z.string().optional(),
    slot: z.string().optional(),
    fallback: z.string().optional(),
  }),

  /** `strike` is the crossed-out "here is what we will not do" pattern. */
  /**
   * `slot` fills the list from lines a session wrote (the `shows` part of a written touch);
   * the block then renders nothing when none were written.
   */
  z.object({
    type: z.literal("list"),
    style: z.enum(["bullet", "strike", "check", "receipt"]).default("bullet"),
    items: z.array(z.string()).min(1).optional(),
    slot: z.string().optional(),
  }),

  /** A spec sheet: pricing rows, plan details, a summary of what was set up. */
  /** `slot` fills the rows from cost lines a session wrote, and renders nothing without them. */
  z.object({
    type: z.literal("card"),
    title: z.string().optional(),
    rows: z.array(z.object({ label: z.string(), value: z.string() })).min(1).optional(),
    slot: z.string().optional(),
    accent: z.boolean().default(false),
  }),

  z.object({ type: z.literal("callout"), fixed: z.string() }),
  z.object({ type: z.literal("divider") }),

  z.object({
    type: z.literal("image"),
    url: z.string(),
    alt: z.string().default(""),
    width: z.number().int().positive().optional(),
    href: z.string().optional(),
  }),

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
export type Block = z.infer<typeof block>;

export const template = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  key: z.string(),
  /** Shown in the editor and the picker. Falls back to the key when absent. */
  name: z.string().optional(),
  channel: channelKey,
  /**
   * How this template is rendered. "html" sends a designed message with the plain text
   * carried alongside as the alternative part; "text" sends the text alone.
   *
   * Some mail is better plain — a founder's own note reads as one when it is not wrapped
   * in a marketing frame — so this is a per-template decision, not a product-wide one.
   */
  format: z.enum(["html", "text"]).default("html"),
  stage: z.string(),
  temp: temperatureBand.optional(),
  /** Resolution is a cascade: person override beats segment beats product default. */
  scope: z.enum(["product_default", "segment", "person_override"]),
  segmentKey: z.string().optional(),
  /**
   * Several first mails competing for the same slot. A campaign's firstTouch or a playbook
   * step names the family; the engine picks the variant nobody has sent this person yet,
   * weighted by what has won so far (`stats.alpha` / `stats.beta`). Each variant is its
   * own key, so "already sent" and "next unused" fall out of the existing rung logic.
   */
  family: z.string().optional(),
  variant: z.string().optional(),
  /** Empty means any segment. Named segments are the only ones this variant is offered to. */
  forSegments: z.array(z.string()).default([]),
  /**
   * Keys of other templates that already showed what this variant shows. A person who was
   * sent any of them is never offered this one: a follow-up that repeats the example their
   * welcome already carried reads as the same mail twice under a new subject.
   */
  covers: z.array(z.string()).default([]),
  personId: objectIdString.optional(),
  version: z.number().int().positive().default(1),
  parentId: objectIdString.optional(),
  blocks: z.array(block).min(1),
  /**
   * The provider's own approved template, for channels that send by name rather than by
   * body.
   *
   * WhatsApp is the case this exists for: outside the 24-hour reply window Meta accepts
   * only a template it has already approved, matched by name, with its parameters supplied
   * separately. The blocks above still render — they are what the reviewer reads and what
   * an in-window free-form message sends — but the send itself carries this instead.
   *
   * `params` maps the provider's parameter name to a merge variable key, so the same
   * approved template serves every person without a second row per recipient. A value that
   * names no known variable is passed through as written, which is how a constant is set.
   */
  providerTemplate: z
    .object({ name: z.string(), params: z.record(z.string(), z.string()).default({}) })
    .optional(),
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
