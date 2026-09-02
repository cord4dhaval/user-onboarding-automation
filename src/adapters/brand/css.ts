import type { BrandAdapter, RawBrand } from "./types.js";

/**
 * Reads a brand off the company's own website.
 *
 * This is the source that needs no account anywhere: the product config already holds a
 * website, so a tenant who has connected nothing still gets mail in their own colours.
 * A dedicated brand provider is an upgrade on this, not a precondition for it.
 */
export class CssBrandAdapter implements BrandAdapter {
  constructor(private readonly url: string) {}

  async fetch(): Promise<RawBrand> {
    assertPublicUrl(this.url);
    const html = await get(this.url);

    const styles: string[] = [];
    for (const inline of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(inline[1] ?? "");

    // Three stylesheets is enough to find a palette and cheap enough to be safe; a page
    // with forty of them is a page whose brand is not in the fortieth.
    const sheets = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
      .map((tag) => attr(tag[0] ?? "", "href"))
      .filter((href): href is string => Boolean(href))
      .slice(0, 3);
    for (const href of sheets) {
      try {
        const absolute = new URL(href, this.url).toString();
        assertPublicUrl(absolute);
        styles.push(await get(absolute));
      } catch {
        // A stylesheet that will not load is not a reason to abandon the whole brand.
      }
    }

    const css = styles.join("\n");
    const vars: Record<string, string> = {};
    for (const declaration of css.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
      const name = declaration[1]!;
      const value = (declaration[2] ?? "").trim();
      if (value && !(name in vars)) vars[name] = value;
    }

    const meta = {
      themeColor: metaContent(html, "theme-color"),
      siteName: metaContent(html, "og:site_name") ?? metaContent(html, "application-name"),
      image: metaContent(html, "og:image"),
      // Kept for display in the UI, never used as a logo.
      icon: absolutise(linkHref(html, /apple-touch-icon/i) ?? linkHref(html, /(^|\s)icon(\s|$)/i), this.url),
      title: (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim() || undefined,
    };

    const fonts = [...css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)]
      .map((match) => (match[1] ?? "").trim())
      .filter((stack) => !stack.startsWith("var("))
      .slice(0, 6);

    return { vars, meta, fonts, guess: guessFromSite(vars, meta, fonts, css) };
  }
}

/**
 * The kit this page implies, used when no token map has been written for the source.
 *
 * Deliberately cautious. A wrong guess that looks confident is worse than an honest gap:
 * the renderer degrades gracefully to a wordmark and a neutral accent, and the overrides
 * form is right there. Everything here is a candidate the user can overrule.
 */
function guessFromSite(
  vars: Record<string, string>,
  meta: Record<string, string | undefined>,
  fonts: string[],
  css: string,
): Record<string, unknown> {
  const kit: Record<string, unknown> = {};

  const named = Object.entries(vars).find(
    ([name, value]) => /(primary|brand|accent)/i.test(name) && isUsableAccent(value),
  )?.[1];
  const accent =
    named ??
    (meta.themeColor && isUsableAccent(meta.themeColor) ? meta.themeColor : undefined) ??
    // Last resort: the saturated colour this stylesheet reaches for most often. On a
    // marketing page that is nearly always the brand.
    mostCommonColour(css);
  if (accent) kit.color = { accent: normaliseHex(accent) };

  // Marketing pages declare several stacks: a display face, a monospace one for code, and
  // whatever serif default the framework shipped with. Body copy set in any of the latter
  // reads as a mistake, so sans is preferred for both roles and the rest are fallbacks.
  const usable = fonts.filter(isUsableFontStack);
  const sans = usable.filter((stack) => genericOf(stack) === "sans");
  const pick = sans.length ? sans : usable.filter((stack) => genericOf(stack) !== "mono");
  const heading = pick[0] ?? usable[0];
  if (heading) {
    const body = pick.find((stack) => stack !== heading) ?? heading;
    kit.font = { headingStack: heading, bodyStack: body };
  }

  // A square touch icon is a mark. An og:image is a 1200x630 social card, and putting one
  // at the top of an email looks like a mistake, so it is never used as a logo.
  if (meta.icon) kit.logo = { light: meta.icon, alt: meta.siteName ?? "", width: 48 };

  const name = tidyName(meta.siteName ?? meta.title);
  if (name) kit.footer = { legalName: name };
  return kit;
}

/** Page titles are sentences. A footer wants the name at the front of one. */
function tidyName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(/\s[|\u2013\u2014\u00b7\-]\s/)[0]?.trim();
  return first && first.length <= 60 ? first : undefined;
}

/**
 * Rejects the things that look like a font stack but are not: documentation prose, an
 * unresolved custom property, a placeholder.
 */
function isUsableFontStack(stack: string): boolean {
  if (!stack || stack.length > 160) return false;
  if (/[<>{}$]|var\(|inherit|initial|unset/i.test(stack)) return false;
  return /[a-z]/i.test(stack);
}

/** Which family a stack lands on when none of its named faces are installed. */
function genericOf(stack: string): "sans" | "serif" | "mono" | "other" {
  if (/mono|courier|consolas|menlo|monaco/i.test(stack)) return "mono";
  if (/\bsans-serif\b|system-ui/i.test(stack)) return "sans";
  if (/\bserif\b|georgia|cambria|times/i.test(stack)) return "serif";
  return "other";
}

function mostCommonColour(css: string): string | undefined {
  const counts = new Map<string, number>();
  for (const match of css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]{5,40}\)/gi)) {
    const value = normaliseHex(match[0]);
    if (!isUsableAccent(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 2; // A colour used once is an accident, not a brand.
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** White, black and near-greys are page background, not brand. */
function isUsableAccent(value: string): boolean {
  const hex = normaliseHex(value);
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturated = max - min > 24;
  const midtone = max > 24 && min < 236;
  return saturated && midtone;
}

function normaliseHex(value: string): string {
  const raw = value.trim().toLowerCase();
  const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = raw.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0"));
    return `#${parts.join("")}`;
  }
  return raw;
}

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { accept: "text/html,text/css,*/*", "user-agent": "Mozilla/5.0 (compatible; brand-kit-reader)" },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`brand read failed: HTTP ${res.status}`);
  // A brand lives in the first few hundred kilobytes or it does not live in this file.
  return (await res.text()).slice(0, 800_000);
}

/**
 * The URL is user-supplied and this fetch runs server-side, so anything pointing back
 * inside the network is refused before a request is made.
 */
function assertPublicUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("brand URL must be http(s)");
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error("brand URL must be a public address");
}

function attr(tag: string, name: string): string | undefined {
  const raw = tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"))?.[1];
  // Attribute values are HTML-encoded in the source. An href carrying a literal "&amp;"
  // into a request is a URL that 404s, which is a hard failure to diagnose later.
  return raw
    ? raw
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
    : undefined;
}

function metaContent(html: string, name: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(pattern)?.[0];
  return tag ? attr(tag, "content") : undefined;
}

function linkHref(html: string, rel: RegExp): string | undefined {
  for (const tag of html.matchAll(/<link[^>]*>/gi)) {
    const relValue = attr(tag[0] ?? "", "rel");
    if (relValue && rel.test(relValue)) return attr(tag[0] ?? "", "href");
  }
  return undefined;
}

function absolutise(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}
