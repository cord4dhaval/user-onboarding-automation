import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { brandKit, type BrandKit } from "../schemas/brand.js";
import { resolveSecret } from "../crypto/broker.js";
import { McpClient } from "../mcp/client.js";
import { schemasFor } from "../mcp/schemas.js";
import { pluck, type Binding } from "../mcp/binding.js";
import type { BrandAdapter } from "../adapters/brand/types.js";
import { ManualBrandAdapter } from "../adapters/brand/manual.js";
import { HttpBrandAdapter } from "../adapters/brand/http.js";
import { CssBrandAdapter } from "../adapters/brand/css.js";
import { McpBrandAdapter } from "../adapters/brand/mcp.js";

export type ResolvedKit = Omit<BrandKit, "orgId" | "productId">;

/**
 * What every product gets before it has told us anything. Deliberately neutral rather
 * than pretty: a default that looks like a brand would be a lie about whose brand it is.
 */
export const DEFAULT_KIT: ResolvedKit = brandKit
  .omit({ orgId: true, productId: true })
  .parse({ color: {}, font: {}, shape: {}, footer: {} });

// ── shape mapping ─────────────────────────────────────────────────────────────

/**
 * Applies a source's token map, so arbitrary provider shapes land in ours.
 *
 * The same idea as `mapRecord` in ingest, with one difference: brand payloads are nested
 * where lead rows are flat, so paths are resolved with `pluck` rather than matched as
 * column names.
 */
export function mapTokens(raw: unknown, tokenMap: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [ours, path] of Object.entries(tokenMap)) {
    const value = path.startsWith("$") ? pluck(raw, path) : path;
    const clean = coerce(ours, value);
    if (clean !== undefined) setPath(out, ours, clean);
  }
  return out;
}

/**
 * A last-resort read of any payload: look for the handful of names every brand system
 * uses. It is what makes a provider usable on the first click, before Claude has written
 * a token map for it.
 */
export function guessKit(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  // An adapter that already knows our shape still goes through coercion: it read those
  // values off a stranger's page, and nothing from there is trusted untested.
  if (source.guess && typeof source.guess === "object") return sanitise(source.guess as Record<string, unknown>);

  const flat = new Map<string, unknown>();
  walk(source, "", flat, 0);
  const find = (pattern: RegExp) => {
    for (const [path, value] of flat) if (pattern.test(path)) return value;
    return undefined;
  };

  const out: Record<string, unknown> = {};
  // Both orders occur in the wild: colorPrimary and primaryColor, brand.accent and accent.
  const accent = coerce("color.accent", find(/(^|\.)(color|colour)?(primary|accent|brand)(color|colour)?(\.\$?value)?$/i));
  if (accent !== undefined) setPath(out, "color.accent", accent);
  const logo = coerce("logo.light", find(/(^|\.)(logo|logourl|logo_light|mark)(\.(url|src|href))?$/i));
  if (logo !== undefined) setPath(out, "logo.light", logo);
  const heading = coerce("font.headingStack", find(/(^|\.)(heading|display|title|primary)?fontfamily$|font.*family$/i));
  if (heading !== undefined) setPath(out, "font.headingStack", heading);
  const name = coerce("footer.legalName", find(/(^|\.)(legalname|companyname|brandname|sitename|name)$/i));
  if (name !== undefined) setPath(out, "footer.legalName", name);
  return out;
}

/** Runs a fragment already in our shape through the same per-field checks as a token map. */
export function sanitise(fragment: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fragment)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = sanitise(value as Record<string, unknown>, path);
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      const clean = coerce(path, value);
      if (clean !== undefined) out[key] = clean;
    }
  }
  return out;
}

function walk(node: unknown, prefix: string, out: Map<string, unknown>, depth: number): void {
  if (depth > 6 || !node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") walk(value, path, out, depth + 1);
    else out.set(path.toLowerCase().replace(/[-_]/g, ""), value);
  }
}

/**
 * Values arriving from a stylesheet or a stranger's API are not trusted to be the right
 * kind. Anything that fails its field's shape is dropped, and the default stands — a
 * half-mapped provider produces a plainer email rather than a schema error at send time.
 */
function coerce(key: string, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  const leaf = key.split(".").pop() ?? key;

  if (/^(bg|surface|text|muted|border|accent|accentText)$/.test(leaf) && key.startsWith("color")) return hex(value);
  if (key.startsWith("darkColor.")) return hex(value);
  if (leaf === "gradient") {
    const list = (Array.isArray(value) ? value : String(value).split(",")).map(hex).filter(Boolean);
    return list.length >= 2 ? list.slice(0, 3) : undefined;
  }
  if (leaf === "light" || leaf === "dark" || leaf === "href" || leaf === "url") return url(value);
  if (/^(width|baseSize|radius|buttonRadius|space|pad|headingWeight)$/.test(leaf)) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  }
  if (/^(headingLeading|bodyLeading)$/.test(leaf)) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0.8 && n < 3 ? n : undefined;
  }
  if (leaf === "scale") {
    const list = (Array.isArray(value) ? value : []).map(Number).filter((n) => Number.isFinite(n));
    return list.length === 5 ? list : undefined;
  }
  if (leaf === "headingStack" || leaf === "bodyStack") {
    const stack = String(value).trim().slice(0, 200);
    if (!stack) return undefined;
    // Mail clients have no webfonts. A stack that names only the brand face renders as
    // whatever the client feels like, so a generic family is appended if none is present.
    return /\b(sans-serif|serif|monospace|cursive|system-ui)\b/i.test(stack)
      ? stack
      : `${stack}, Helvetica, Arial, sans-serif`;
  }
  if (leaf === "social") return Array.isArray(value) ? value : undefined;
  if (leaf === "topRule") return Boolean(value);
  return typeof value === "string" ? value.trim().slice(0, 400) : undefined;
}

function hex(value: unknown): string | undefined {
  const raw = String(value).trim().toLowerCase();
  const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = raw.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(raw) ? raw : undefined;
}

function url(value: unknown): string | undefined {
  try {
    const parsed = new URL(String(value));
    // A relative or data URL is useless in mail: Gmail strips both.
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  provenance: Record<string, string>,
  label: string,
  prefix = "",
): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const existing = (out[key] ?? {}) as Record<string, unknown>;
      out[key] = deepMerge(existing, value as Record<string, unknown>, provenance, label, path);
    } else {
      out[key] = value;
      provenance[path] = label;
    }
  }
  return out;
}

// ── fetch and rebuild ─────────────────────────────────────────────────────────

async function buildAdapter(source: Record<string, unknown>): Promise<BrandAdapter> {
  const db = await getDb();
  const kind = String(source.kind);

  if (kind === "manual") return new ManualBrandAdapter((source.literal ?? {}) as Record<string, unknown>);
  if (kind === "css_vars") {
    if (!source.url) throw new Error("a website brand source needs a URL");
    return new CssBrandAdapter(String(source.url));
  }

  const connectionId = source.connectionId ? String(source.connectionId) : undefined;
  const secret = connectionId
    ? await resolveSecret(String(source.orgId), connectionId, "engine.brand")
    : undefined;

  if (kind === "http_tokens") {
    if (!source.url) throw new Error("a token endpoint brand source needs a URL");
    return new HttpBrandAdapter(String(source.url), secret);
  }

  if (!connectionId) throw new Error("an MCP brand source needs a connection");
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection?.serverUrl) throw new Error("brand connection has no server URL");
  const binding = await db.collection(C.mcpBindings).findOne({ orgId: String(source.orgId), connectionId });
  if (!binding?.bind || !(binding.bind as Record<string, unknown>).fetch_brand) {
    throw new Error("this connection has no brand tool bound");
  }
  const client = new McpClient(String(connection.serverUrl), secret ?? "", await schemasFor(connectionId));
  return new McpBrandAdapter(client, binding.bind as Binding, String(source.productId));
}

/**
 * Fetches one source and stores what it resolved to, on the source itself.
 *
 * The fragment is kept per source rather than merged straight into the kit so that a
 * provider going down degrades that one contribution instead of blanking the brand.
 */
export async function refreshBrandSource(sourceId: string): Promise<Record<string, unknown>> {
  const db = await getDb();
  const source = await db.collection(C.brandSources).findOne({ _id: new ObjectId(sourceId) });
  if (!source) throw new Error(`brand source ${sourceId} not found`);

  const interval = Number(source.refreshEverySec ?? 86_400);
  try {
    const adapter = await buildAdapter(source);
    const raw = await adapter.fetch();
    const tokenMap = (source.tokenMap ?? {}) as Record<string, string>;
    // A token map is the precise instrument; the guess is what makes a provider useful
    // before anyone has written one.
    const mapped = Object.keys(tokenMap).length > 0 ? mapTokens(raw, tokenMap) : guessKit(raw);

    await db.collection(C.brandSources).updateOne(
      { _id: source._id },
      {
        $set: {
          resolved: mapped,
          lastRunAt: new Date(),
          nextFetchAt: new Date(Date.now() + interval * 1000),
          health: { status: Object.keys(mapped).length ? "healthy" : "degraded", ...(Object.keys(mapped).length ? {} : { error: "nothing recognisable in the response" }) },
        },
      },
    );
    await rebuildKit(String(source.orgId), String(source.productId));
    return mapped;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.collection(C.brandSources).updateOne(
      { _id: source._id },
      {
        $set: {
          lastRunAt: new Date(),
          nextFetchAt: new Date(Date.now() + interval * 1000),
          health: { status: "degraded", error: message },
        },
      },
    );
    throw err;
  }
}

/** Merges every source's stored fragment, lowest precedence first, over the default kit. */
export async function rebuildKit(orgId: string, productId: string): Promise<ResolvedKit> {
  const db = await getDb();
  const sources = await db
    .collection(C.brandSources)
    .find({ orgId, productId, enabled: true })
    .sort({ precedence: 1 })
    .toArray();

  const provenance: Record<string, string> = {};
  let merged: Record<string, unknown> = {};
  for (const source of sources) {
    const fragment = (source.resolved ?? {}) as Record<string, unknown>;
    if (Object.keys(fragment).length === 0) continue;
    merged = deepMerge(merged, fragment, provenance, String(source.kind === "manual" ? "manual" : source.kind === "css_vars" ? "css" : source.kind === "http_tokens" ? "http" : "mcp"));
  }

  const parsed = brandKit.omit({ orgId: true, productId: true }).safeParse({
    ...merged,
    provenance,
    fetchedAt: new Date(),
  });
  // Every value was coerced on the way in, so a failure here means a provider sent
  // something structurally strange. Keep the default rather than blocking sends.
  const kit = parsed.success ? parsed.data : DEFAULT_KIT;

  await db
    .collection(C.brandKits)
    .updateOne({ orgId, productId }, { $set: { orgId, productId, ...kit } }, { upsert: true });
  return kit;
}

/**
 * What the renderer calls. Reads the merged snapshot only — never a provider, never a
 * network call. A first touch fires seconds after a lead lands and cannot wait on anyone
 * else's uptime.
 */
export async function loadBrandKit(orgId: string, productId: string): Promise<ResolvedKit> {
  const db = await getDb();
  const doc = await db.collection(C.brandKits).findOne({ orgId, productId });
  if (!doc) return DEFAULT_KIT;
  const parsed = brandKit.omit({ orgId: true, productId: true }).safeParse(doc);
  return parsed.success ? parsed.data : DEFAULT_KIT;
}

/**
 * Gives a product a brand before anyone has connected anything, from the website already
 * in its config. The badge that offers a dedicated provider then offers an improvement
 * rather than a prerequisite.
 */
export async function ensureWebsiteBrandSource(orgId: string, productId: string): Promise<boolean> {
  const db = await getDb();
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId });
  const website = (product?.config as { website?: string } | undefined)?.website;
  if (!website) return false;

  const existing = await db.collection(C.brandSources).findOne({ orgId, productId, kind: "css_vars" });
  if (existing) return false;

  await db.collection(C.brandSources).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    name: "Website",
    kind: "css_vars",
    url: website,
    tokenMap: {},
    precedence: 10,
    refreshEverySec: 604_800,
    enabled: true,
  });
  return true;
}
