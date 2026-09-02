import { z } from "zod";
import { objectIdString } from "./common.js";

/**
 * The visual half of brand. `product.config.voice` already covers how a product sounds;
 * this covers how it looks, so an HTML email can be assembled without a designer and
 * without any per-tenant markup.
 *
 * Every field has a default. A kit that arrives half-populated produces a plainer email,
 * never a broken one — an unbranded send is worse mail, not a failed send.
 */

const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected a hex colour");

export const brandPalette = z.object({
  /** Behind the message card. Mail clients show this at the edges. */
  bg: hex.default("#F4F5F7"),
  /** The card itself. */
  surface: hex.default("#FFFFFF"),
  text: hex.default("#101114"),
  muted: hex.default("#6B7280"),
  border: hex.default("#E5E7EB"),
  accent: hex.default("#2C5CFF"),
  accentText: hex.default("#FFFFFF"),
  /** Two or three stops for a gradient CTA. Empty means a flat accent button. */
  gradient: z.array(hex).default([]),
});
export type BrandPalette = z.infer<typeof brandPalette>;

export const brandKit = z.object({
  orgId: objectIdString,
  productId: objectIdString,

  logo: z
    .object({
      /** Must be an absolute hosted URL: Gmail strips CID attachments and data URIs alike. */
      light: z.string().url(),
      dark: z.string().url().optional(),
      width: z.number().int().positive().default(132),
      alt: z.string().default(""),
      href: z.string().url().optional(),
    })
    .optional(),

  color: brandPalette,
  /** Only the keys that actually differ in dark mode need to be present. */
  darkColor: brandPalette.partial().optional(),

  font: z.object({
    /** Both stacks must end in a websafe family — a webfont is a bonus, never a dependency. */
    headingStack: z.string().default("'Inter', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"),
    bodyStack: z.string().default("-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"),
    baseSize: z.number().int().min(12).max(20).default(16),
    /** h1, h2, h3, body, small — in pixels. */
    scale: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).default([34, 24, 18, 16, 13]),
    headingWeight: z.number().int().default(700),
    /** Tight leading on display type is most of what makes an email look designed. */
    headingLeading: z.number().default(1.15),
    bodyLeading: z.number().default(1.6),
  }).default({}),

  shape: z.object({
    radius: z.number().int().nonnegative().default(14),
    buttonRadius: z.number().int().nonnegative().default(999),
    /** Vertical rhythm between blocks, in pixels. */
    space: z.number().int().positive().default(22),
    /** Inner padding of the message card. */
    pad: z.number().int().positive().default(36),
    /** A coloured hairline across the top of the card, as Holo and Linear both use. */
    topRule: z.boolean().default(true),
  }).default({}),

  footer: z.object({
    legalName: z.string().default(""),
    address: z.string().optional(),
    social: z.array(z.object({ label: z.string(), url: z.string().url() })).default([]),
    disclaimer: z.string().optional(),
  }).default({}),

  /** Where each field came from, so the UI can show what is real and what is a default. */
  provenance: z.record(z.string(), z.enum(["mcp", "http", "css", "manual", "default"])).default({}),
  fetchedAt: z.date().optional(),
});
export type BrandKit = z.infer<typeof brandKit>;

/**
 * A brand source is a fetch job on a connection, exactly as a lead source is. The parallel
 * is deliberate: a second provider is a row here plus a token map, never new code.
 *
 * Several may coexist. They are deep-merged in ascending `precedence`, so a palette can
 * come from a brand server while the logo comes from the company's own CDN and one hex is
 * corrected by hand.
 */
export const brandSource = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  /** Absent for `manual`, which needs no server and no credential. */
  connectionId: objectIdString.optional(),
  name: z.string(),
  kind: z.enum(["mcp_brand", "http_tokens", "css_vars", "manual"]),

  /** Set for `http_tokens` and `css_vars`. */
  url: z.string().url().optional(),
  /** Set for `manual` — the kit fragment typed into the form. */
  literal: z.record(z.string(), z.unknown()).optional(),

  /**
   * Our field name to a dot path into whatever the provider returned, e.g.
   * `{ "color.accent": "$.brand.colors.primary" }`. Claude writes it once from a sample
   * payload; the engine never learns any provider's shape.
   */
  tokenMap: z.record(z.string(), z.string()).default({}),

  /** Higher wins on conflict. Hand-entered values sit above anything fetched. */
  precedence: z.number().int().default(10),
  refreshEverySec: z.number().int().positive().default(86_400),
  nextFetchAt: z.date().optional(),
  lastRunAt: z.date().optional(),
  enabled: z.boolean().default(true),
  health: z.object({ status: z.string(), error: z.string().optional() }).optional(),
});
export type BrandSource = z.infer<typeof brandSource>;
