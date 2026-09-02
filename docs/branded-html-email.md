# Branded HTML email

Status: built. Last updated 2026-09-01.

HTML is the default rendering for email; the plain-text part ships alongside it in the
same message rather than as a second code path. Making that worth doing needs the tenant's
actual visual identity — logo, palette, type scale, button shape — which the system now
holds as a brand kit assembled from one or more sources.

Nothing here introduces a new mechanism. Brand is a third instance of the pattern the
codebase already uses twice, for leads coming in and messages going out:

| layer | leads in | messages out | brand in |
| --- | --- | --- | --- |
| auth | connection `direction: "in"` | `"out"` | `"brand"` |
| transport | `SourceAdapter` | `ChannelAdapter` | `BrandAdapter` |
| shape | `source.fieldMap` | `mcpBinding.bind` | `brandSource.tokenMap` |
| resolve | `buildAdapter` in `runSource.ts` | `resolveChannelAdapter` | `buildAdapter` in `brand.ts` |
| normalised store | `people` | `actions` | `brand_kits` |
| clock | tick, `nextFetchAt` | tick, `fireDue` | tick, `nextFetchAt` |

The engine contains no provider-aware code. A second brand provider is a row in
`brand_sources` plus a token map, exactly as a second lead source is a row plus a field
map.

## Where the values come from

`src/adapters/brand/` holds four adapters behind one interface:

| kind | input | who it serves |
| --- | --- | --- |
| `css_vars` | fetches a public page, reads custom properties, `theme-color`, fonts, touch icon | anyone with a website and no account anywhere |
| `http_tokens` | GET JSON | Style Dictionary output, a W3C token file, an in-house brand API |
| `mcp_brand` | `invoke(client, bind, "fetch_brand", …)` | any MCP server exposing a brand tool |
| `manual` | typed into the overrides form | correcting one value, or a tenant with no machine-readable brand at all |

`css_vars` is the one that makes the empty state honest. The product config already holds
a website, so a tenant who has connected nothing still sends mail in their own colours; a
dedicated brand provider is an upgrade on that, never a precondition for it.

Several sources coexist. Each stores its own resolved fragment on itself, and
`rebuildKit` deep-merges them in ascending `precedence` over `DEFAULT_KIT`. So a palette
can come from a provider while the logo comes from a CDN and one hex is corrected by hand,
and a provider going down degrades its own contribution instead of blanking the brand.
Hand-typed values sit at precedence 90, above anything fetched, so a refresh can never
overwrite a decision somebody made on purpose.

### Token maps

`mapTokens` applies a source's map, resolving each right-hand side with `pluck` from
`mcp/binding.ts` — brand payloads are nested where lead rows are flat, which is the only
difference from `mapRecord` in ingest.

```ts
// a brand MCP
{ "color.accent": "$.brand.colors.primary", "logo.light": "$.brand.assets.logoLight.url" }
// a W3C token file, same code
{ "color.accent": "$.color.brand.500.$value", "font.headingStack": "$.font.display.$value" }
```

A source with no map yet falls back to `guessKit`, which looks for the handful of names
every brand system uses. That is what makes a provider useful on the first click, before
Claude has written a map for it.

Everything crossing that boundary is coerced per field: a colour that will not parse, a
relative logo URL, a font stack containing markup — all dropped, with the default standing.
A half-mapped provider produces a plainer email, never a schema error at send time. Font
stacks additionally get `Helvetica, Arial, sans-serif` appended when they name no generic
family, because mail clients have no webfonts.

Reading a website is a server-side fetch of a user-supplied URL, so `assertPublicUrl`
refuses loopback and private ranges before any request is made.

## Rendering

`resolveBlocks` in `compose.ts` applies merge fields and composed copy and returns a list
of resolved blocks. Both renderers read that list — `renderTemplate` joins it into the
text part, `renderHtml` wraps it in tables — so the two parts of a message cannot drift.
That matters because validation runs against the text.

`src/engine/html.ts` holds the design decisions, fixed in code rather than left to a
model: 600px centred table layout, one accent, a real type scale with tight display
leading, generous vertical rhythm, a single button, a footer that says who is writing.
Also: inline styles only, a `prefers-color-scheme` block with a derived dark palette when
the brand supplies none, a VML `roundrect` so Outlook shows a real button, a gradient
`background-image` over a solid `background-color`, and a hidden preheader with trailing
filler so the client cannot pad the inbox preview with the greeting.

Everything is escaped before any markup is added, and only a small markdown subset —
bold, italic, links, line breaks — is re-introduced. Nothing a model writes can emit a tag.

A representative message renders at roughly 9KB; Gmail clips past 102KB, and both the
editor and `preview_template` report the size.

### Blocks

`subject`, `preheader`, `heading`, `text`, `slot`, `list` (bullet, tick, struck through),
`card`, `callout`, `divider`, `image`, `cta`, `system`. Blocks carry no styling — that is
what lets one template look right for every tenant and lets a brand refresh restyle every
template without touching one of them. Every type degrades to text, so the markdown part
stays honest.

Slots may be named, which lets one template hold several independently written sections.
An unnamed slot keeps the original behaviour of taking the composed body wholesale, and
only the first one does.

### The freeze rule

`fireDue` ships an approved message exactly as it was reviewed. HTML derived at send time
would break that: a brand refreshed between approval and send would change the message
after a human signed off on it. So `bodyHtml` is rendered at the moment the text is, stored
inside `action.content`, and reused thereafter. The kit is loaded once per run rather than
once per recipient.

`capabilities.html` gates the whole thing. A channel whose send tool has no HTML argument
is inferred as `html: false` by `discover.ts` and gets text only, with no configuration.

## What Claude does, and what it must not

**Claude never writes HTML.** It writes structure and copy; the engine writes the markup.
That removes the injection surface, keeps Outlook from breaking, and makes brand drift
impossible.

| tool | purpose |
| --- | --- |
| `get_brand` | The resolved kit and where each value came from, including whether the product is branded at all. A headline written for a 34px display face is a different sentence from one written for a paragraph. |
| `upsert_template` | Creates or replaces a template. Blocks are validated against the schema at the tool boundary, so a malformed block fails here rather than per-message hours later. Replacing blocks bumps the version — the old numbers were collected against different words. |
| `preview_template` | Renders exactly as the engine would, for a real person or a sample one, and returns validation plus the HTML size. |

`compose_batch` is unchanged: `body` stays markdown and fills the slots, so Claude improves
copy on every sweep without touching layout. The improvement loop then closes on machinery
that already existed — `template.stats` carries alpha/beta, `report` exposes the outcome,
`upsert_template` writes the next version, and the `product_default` → `segment` →
`person_override` cascade routes it.

## The interface

- **Brand** (`/products/[id]/brand`) — live preview of a sample message in the resolved
  kit, the palette with provenance, the source list with health, forms for each source
  kind, and the overrides form.
- **Templates** — create, duplicate and delete, with each row linking to its editor.
- **Template editor** (`/products/[id]/templates/[tid]`) — per-block forms, reorder,
  add and remove, a live HTML preview beside a plain-text toggle, validation, and the
  constraint settings. New templates start as drafts; a draft is never picked by the
  cascade.
- **`BrandBadge`** — the same job `ClaudeBadge` does for queued work: the difference
  between "broken" and "not set up yet". With no kit it offers reading the website first,
  then a provider account, then the generic connect-an-MCP route. The suggested provider
  is configuration (`BRAND_PROVIDER_NAME`, `BRAND_PROVIDER_SIGNUP_URL`,
  `BRAND_PROVIDER_MCP_URL`), so an unset deployment advertises nothing.

## Things that will bite

- The logo must be an absolute hosted URL. Gmail strips CID attachments and data URIs
  alike, and the coercion drops anything relative rather than sending a broken image.
- A website guess deliberately never uses `og:image` as a logo — that is a 1200×630 social
  card, and putting one at the top of an email looks like a mistake. A square touch icon is
  used when present; otherwise the renderer sets the legal name as a wordmark.
- `validate()` runs against markdown, not HTML. Keep it that way — word counts and claim
  checks are only meaningful against the semantic form.
- Deleting a template is refused while a touch is still queued against it, because queued
  mail renders from its template at send time.
- A brand refresh must never mutate mail already sent. It does not: `action.content` is
  frozen at send time and now carries its own HTML.

## Not built

- Per-brand webfont delivery. Deliberate — mail clients do not load them reliably and the
  fallback stack is what actually renders.
- A visual block designer with drag and drop. The editor reorders with buttons, which
  works without client-side state.
- Litmus-style client screenshots. Worth adding once a real tenant is sending volume.
