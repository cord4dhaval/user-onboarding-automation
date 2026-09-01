# Branded HTML email

Status: planned, not implemented. Written 2026-09-01.

HTML is the default rendering for email; plain text remains as the alternative part of
the same message rather than a second code path. Making that worth doing requires the
brand's actual visual identity — logo, palette, type scale, button shape — which the
system does not hold today. This document describes where that data comes from, who
renders it, and what Claude is allowed to touch.

## What exists today

- `OutboundMessage.bodyHtml` is already declared in `src/adapters/channel/types.ts` and
  already passed through by `SmtpAdapter.send` (`src/adapters/channel/smtp.ts`). Nothing
  ever sets it — `toOutbound` in `src/engine/compose.ts` returns text only.
- `discover.ts` already infers an `html` capability from a send tool's argument names, so
  the gate for "this channel cannot do HTML" is in place and unused.
- Template blocks are semantic (`subject`, `text`, `slot`, `cta`, `asset`, `system`), with
  no design information in them. This is correct and should stay that way — design comes
  from the brand kit at render time, not from stored markup.
- `product.config.voice` covers verbal brand. There is no equivalent for visual brand.

## 1. Brand as a third connection direction

A brand provider is neither a lead source nor a send channel, so `directions` grows a
third value:

```ts
// src/schemas/connection.ts
directions: z.array(z.enum(["in", "out", "brand"])).min(1),
```

Discovery gets a matching verb so the existing binding machinery can find the tool
whatever the provider happened to name it:

```ts
// src/mcp/discover.ts — candidatesFor patterns
fetch_brand: /brand|style|identity|design.?token|palette|theme|kit/i,
```

BrandGrid is the expected first provider (its `get_brand_style` tool returns the whole
sheet in one call), but nothing in the engine names it. Any MCP server exposing a brand
tool binds the same way, which keeps the "a new provider is data, not code" claim intact.

## 2. Cache the kit; never fetch it at send time

A first touch fires within seconds of a lead landing. It cannot wait on a third-party MCP
round trip, and it must still render if that server is down. So the kit is snapshotted
into its own collection on connect and on explicit refresh, and the send path reads only
the snapshot.

Add `brandKits: "brand_kits"` to `src/db/collections.ts`, and a schema:

```ts
// src/schemas/brand.ts (new)
export const brandKit = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  /** Absent when the kit was entered by hand rather than pulled from a provider. */
  connectionId: objectIdString.optional(),
  source: z.enum(["mcp", "human", "default"]),
  logo: z.object({
    light: z.string().url(),
    dark: z.string().url().optional(),
    width: z.number().int().default(120),
    alt: z.string(),
  }).optional(),
  color: z.object({
    bg: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
    border: z.string(),
    accent: z.string(),
    accentText: z.string(),
    /** Two or three stops for a gradient CTA; empty means a flat accent button. */
    gradient: z.array(z.string()).default([]),
  }),
  darkColor: z.object({ /* same keys */ }).partial().optional(),
  font: z.object({
    /** Both stacks must end in a websafe family — a web font is a bonus, never a dependency. */
    headingStack: z.string(),
    bodyStack: z.string(),
    baseSize: z.number().default(16),
    scale: z.array(z.number()).default([32, 24, 18, 16, 14]),
  }),
  shape: z.object({
    radius: z.number().default(12),
    buttonRadius: z.number().default(999),
  }),
  footer: z.object({
    legalName: z.string(),
    address: z.string().optional(),
    social: z.array(z.object({ label: z.string(), url: z.string().url() })).default([]),
    disclaimer: z.string().optional(),
  }),
  fetchedAt: z.date(),
  toolsHash: z.string().optional(),
});
```

Fetching reuses `invoke` from `src/mcp/binding.ts`, so there is no new transport code:

```ts
// src/engine/brand.ts (new)
const raw = await invoke(client, binding.bind, "fetch_brand", { productId });
const kit = normalizeBrand(raw);
await db.collection(C.brandKits).updateOne({ orgId, productId }, { $set: kit }, { upsert: true });
```

`normalizeBrand` is the only provider-aware function in the system: it maps whatever the
server returns (CSS custom properties, a design-token JSON file, a flat palette object)
onto the schema above. A missing key falls back to the neutral default kit. It never
throws and never blocks a send — an unbranded email is a worse email, not a failed one.

## 3. Rendering

`renderTemplate` keeps its job: it produces the semantic `ComposedContent` that
`validate()`, the word count, and the claim ledger all depend on. HTML is a second,
purely additive pass over the same blocks.

```ts
// src/engine/html.ts (new)
export function renderHtml(
  blocks: Block[],
  vars: MergeVars,
  brand: BrandKit,
  content: ComposedContent,
): string
```

Constraints are enforced in this function rather than left to a model:

- 600px centred `<table role="presentation">` layout. No flex, no grid, no external
  stylesheet. One `<head>` block only, for the dark-mode media query and the Outlook
  conditional.
- Every colour is inlined from `brand.color`. Nothing is hardcoded.
- The CTA renders as a gradient `background-image` over a solid `background-color`, with a
  VML fallback for Outlook. Outlook gets a flat accent button, which still looks
  deliberate.
- Font stacks always end in `Arial, sans-serif`.
- `@media (prefers-color-scheme: dark)` swaps to `brand.darkColor` when it is present.
- `opt_out_block` renders as a real footer built from `brand.footer` — legal name,
  address, unsubscribe link. This is the CAN-SPAM and GDPR requirement, not decoration.
- Total output stays under 100KB or Gmail clips the message.

### Block types to add later

The four existing content block types are enough to ship. Once the renderer is verified
in real clients, the union can grow to cover the layouts marketing email actually uses.
Every added type needs a plain-text degrade in `renderTemplate` so the markdown path stays
honest.

```ts
z.object({ type: z.literal("heading"), slot: z.string(), fallback: z.string().optional(), level: z.number().default(1) }),
z.object({ type: z.literal("list"), style: z.enum(["bullet", "strike", "check"]), items: z.array(z.string()) }),
z.object({ type: z.literal("card"), title: z.string().optional(), rows: z.array(z.object({ label: z.string(), value: z.string() })) }),
z.object({ type: z.literal("divider") }),
```

A `strike` list is the "we cannot do any of this for you" pattern; a `card` is the
spec-sheet box. Both are structure, and both take their appearance from the kit.

Preview text — the snippet the inbox shows next to the subject — is a hidden div
immediately after `<body>`. It deserves its own slot block eventually; after the subject
line it is the largest open-rate lever available.

### Wiring it in

```ts
// src/engine/compose.ts
export function toOutbound(content, to, from?, html?: string): OutboundMessage {
  return { to, from, subject: content.subject, bodyText: content.bodyMd, bodyHtml: html };
}
```

```ts
// src/engine/fireDue.ts — after validate(), before adapter.send()
const caps = channel.capabilities as { html?: boolean } | undefined;
const brand = await loadBrandKit(opts.orgId, opts.productId);
const html =
  caps?.html !== false && String(action.channel) === "email"
    ? renderHtml(template.blocks as Block[], vars, brand, content)
    : undefined;
const outbound = toOutbound(content, email, channel.from as string | undefined, html);
```

Text is always sent alongside. Nodemailer already emits `text` and `html` as a multipart
alternative, so "plain text as an option" costs nothing and needs no separate path. An MCP
channel whose send tool has no HTML argument is inferred as `html: false` by
`discover.ts` and degrades automatically.

## 4. What Claude does, and what it must not

**Claude never writes HTML.** It writes structure and copy; the engine writes the markup.
That boundary removes the injection surface, keeps Outlook from breaking, and makes brand
drift impossible.

Three tools to add to `src/mcp/server/tools.ts`:

| Tool | Purpose |
| --- | --- |
| `get_brand` | Returns the cached kit, so copy is written to fit the design — a short headline because the heading scale starts at 32px, an offer that reads against the accent colour. |
| `upsert_template` | Creates and versions block arrays. The comment at the top of `src/engine/templates.ts` already promises this tool exists; it does not yet. |
| `preview_template` | Renders blocks plus brand to HTML and returns a signed preview URL, so Claude can check its own work before a human sees it. |

`compose_batch` is unchanged. Its `body` argument stays markdown, filling the `slot`
blocks; layout continues to come from the template. That separation is what lets Claude
improve copy on every sweep without touching the design.

The improvement loop then closes on machinery that already exists: `template.stats`
carries `alpha`/`beta`, `report` exposes the outcome, `upsert_template` writes a v2, and
the existing `product_default` → `segment` → `person_override` cascade routes it.

## 5. Surfacing the missing kit

An account with no brand connection is not broken, it is not set up yet — the same
distinction `ClaudeBadge` exists to draw. A `BrandBadge` in `app/ui/brand-badge.tsx`
mirrors it: when a kit is present it shows the source, and when it is absent it explains
that mail is going out unstyled and offers the two steps to fix it — create a BrandGrid
account, then connect the MCP server.

`app/products/[id]/connections/new/page.tsx` already reads a probed URL out of
`searchParams` and uses it as the field's `defaultValue`, so the badge can link straight
there with `?serverUrl=…` prefilled and connecting becomes Check, then authorise.

The badge belongs on the templates page, the channels page, and the product overview.

## Implementation order

1. `src/schemas/brand.ts`, `brandKits` in `collections.ts`, the `"brand"` direction, and
   the `fetch_brand` pattern in `discover.ts`.
2. `src/engine/brand.ts` — `loadBrandKit`, `refreshBrandKit`, `DEFAULT_KIT`, `normalizeBrand`.
3. `src/engine/html.ts`, supporting the four existing content block types only. Ship it and
   verify in Gmail, Outlook, and Apple Mail before going further.
4. Wire `fireDue` and `toOutbound`, gated on `capabilities.html`.
5. Extend the block union with `heading`, `list`, `card`, `divider`, each with a text degrade.
6. Add `get_brand`, `upsert_template`, `preview_template`.
7. Add `BrandBadge` and a "Refresh brand" server action beside it.

Steps 1–4 alone put brand-coloured HTML on every send. Steps 5–7 are what let Claude
design rather than only write.

## Things that will bite

- The logo must be an absolute hosted URL. Gmail strips both CID attachments and data
  URIs. If the brand provider hosts the asset, use its URL directly.
- `validate()` runs against markdown, not HTML. Keep it that way — word counts and claim
  checks stay meaningful only against the semantic form.
- A brand refresh must version templates, never mutate mail already sent. `action.content`
  is frozen at send time today, so the history stays accurate as long as the HTML pass
  remains derived rather than stored.
