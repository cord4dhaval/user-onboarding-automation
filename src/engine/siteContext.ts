import type { Document } from "mongodb";
import { SITE_PAGE_KINDS, type SiteContext } from "../schemas/product.js";
import { textFromHtml } from "./enrich.js";

/**
 * Reading a product's own website, page by page, for its company context.
 *
 * Done here, by the engine, because a routine has no browser: the monthly refresh runs as
 * a scheduled session that can only call tools. Two things make that harder than one
 * fetch. A site's pages have to be found before they can be read, and the sitemap is the
 * honest list; the home page's links are the fallback. And many product sites are built
 * in the browser, so a plain fetch returns the same empty shell for every page (teamgrid.ai
 * does: 640 characters, one title, for all 35 pages). A page that comes back that thin is
 * read again through a rendering reader, which runs the page's scripts first.
 */

const UA = "Mozilla/5.0 (compatible; conversion-engine/1.0; +https://teamgrid.ai)";
/**
 * Enough of a page to summarise it. A home page runs long, and its customer quotes and
 * logos sit near the bottom (teamgrid.ai's start after 9,000 characters).
 */
export const PAGE_TEXT_MAX = 12000;
/** Below this, a fetched page is a script shell, not content. */
const THIN_PAGE = 400;
/** A sitemap listing more than this is mostly blog posts; the rest are not worth mapping. */
const MAP_MAX = 300;
/**
 * Pages read in one call. A rendered read takes about 20 seconds and the MCP route stops
 * at 60, so a call reads a handful in parallel and the session asks again for the rest.
 */
export const READ_BATCH_MAX = 4;

/** The reader that renders a page before reading it. r.jina.ai by default; SITE_READER_URL overrides. */
function readerUrl(): string {
  return (process.env.SITE_READER_URL ?? "https://r.jina.ai/").replace(/\/?$/, "/");
}

/** The host a product's pages must live on, without www. */
export function siteHost(website: string): string {
  try {
    return new URL(website).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Whether a URL is a page of the product's own site. */
export function onSite(url: string, website: string): boolean {
  const host = siteHost(website);
  if (!host) return false;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname.replace(/^www\./, "").toLowerCase() === host;
  } catch {
    return false;
  }
}

/** One spelling per page: no fragment, no trailing slash except the root, no tracking tags. */
export function normalisePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(key)) parsed.searchParams.delete(key);
    let out = parsed.toString();
    if (parsed.pathname !== "/" && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return url;
  }
}

/** A first guess at what a page is, from its path. The session reading it has the last word. */
export function kindFromPath(url: string): (typeof SITE_PAGE_KINDS)[number] {
  let path = "/";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "other";
  }
  if (path === "/" || path === "") return "home";
  const rules: Array<[RegExp, (typeof SITE_PAGE_KINDS)[number]]> = [
    [/\/(compare|vs|versus|alternative)s?\b|-vs-/, "compare"],
    [/\/pricing|\/plans?\b/, "pricing"],
    [/\/(security|trust|compliance|gdpr|soc-?2)/, "security"],
    [/\/(solutions?|use-cases?|industries|for)\//, "solution"],
    [/\/features?\b|\/product\//, "feature"],
    [/\/(book-demo|demo|request-demo)/, "demo"],
    [/\/(contact|contact-us|support)\b/, "contact"],
    [/\/(about|company|team|careers)\b/, "about"],
    [/\/(blog|articles?|news|resources|guides?)\b/, "blog"],
    [/\/(privacy|terms|legal|cookie|refund)/, "legal"],
  ];
  for (const [pattern, kind] of rules) if (pattern.test(path)) return kind;
  return "other";
}

async function fetchText(url: string, accept: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 2_000_000);
  } catch {
    return null;
  }
}

/** Links in a rendered page's text, which the reader writes as <url> or [words](url). */
function linksInText(text: string): RegExpMatchArray[] {
  return [...text.matchAll(/<(https?:\/\/[^>\s]+)>/g), ...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)];
}

function locsIn(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

/**
 * Every page the site says it has: the sitemaps robots.txt names (or /sitemap.xml), one
 * level of sitemap index followed, and every link on the home page. Sign-in and account
 * pages are left out; nothing there is written for a buyer.
 */
export async function siteMap(website: string): Promise<{ pages: Array<{ url: string; kind: string }>; from: "sitemap" | "sitemap+home_links" | "home_links" | "none"; truncated: boolean }> {
  const root = new URL(website).origin;
  const robots = (await fetchText(`${root}/robots.txt`, "text/plain", 8000)) ?? "";
  const named = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  const maps = named.length ? named : [`${root}/sitemap.xml`];

  const found: string[] = [];
  for (const map of maps.slice(0, 5)) {
    const xml = await fetchText(map, "application/xml,text/xml", 10000);
    if (!xml) continue;
    const locs = locsIn(xml);
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locs.slice(0, 10)) {
        const inner = await fetchText(child, "application/xml,text/xml", 10000);
        if (inner) found.push(...locsIn(inner));
      }
    } else {
      found.push(...locs);
    }
  }

  // The home page's own links as well, even with a sitemap: a sitemap written once and
  // never updated misses every page added since (teamgrid.ai's lists 35 pages; its menu
  // links a dozen more, CRM, HRMS and Security among them). Read rendered, so a site built
  // in the browser still shows its menu.
  const fromMap = found.length;
  found.push(...(await readPage(root)).links, root);
  const from: "sitemap" | "sitemap+home_links" | "home_links" | "none" =
    fromMap && found.length > fromMap + 1 ? "sitemap+home_links" : fromMap ? "sitemap" : found.length > 1 ? "home_links" : "none";

  const seen = new Set<string>();
  const pages: Array<{ url: string; kind: string }> = [];
  for (const raw of found) {
    const url = normalisePageUrl(raw);
    if (!onSite(url, website) || seen.has(url)) continue;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|xml|txt|json|webmanifest|zip|mp4)(\?|$)/i.test(url)) continue;
    if (/\/(login|log-in|signin|sign-in|logout|register|signup|sign-up|partner-login|dashboard|account|cart|checkout)(\/|$|\?)/i.test(url)) continue;
    seen.add(url);
    pages.push({ url, kind: kindFromPath(url) });
  }
  // Blog posts crowd out the pages that sell; keep the map led by everything else.
  pages.sort((a, b) => Number(a.kind === "blog") - Number(b.kind === "blog"));
  return { pages: pages.slice(0, MAP_MAX), from, truncated: pages.length > MAP_MAX };
}

/**
 * One page's words. A plain fetch first; a page that returns a script shell is read again
 * through the rendering reader. `via` says which, so a thin result can be told from a
 * failed one.
 */
export async function readPage(url: string): Promise<{ url: string; title?: string; text: string; links: string[]; via: "fetch" | "reader" | "failed" }> {
  const html = await fetchText(url, "text/html", 10000);
  if (html) {
    const text = textFromHtml(html);
    if (text.length >= THIN_PAGE) {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
      const links = [...html.matchAll(/href="([^"#]+)"/gi)].flatMap((m) => absolute(m[1]!, url));
      return { url, ...(title ? { title } : {}), text: text.slice(0, PAGE_TEXT_MAX), links, via: "fetch" };
    }
  }
  // X-Timeout lets the page's scripts finish; without it a script-built page reads as empty.
  // The links summary lists every link on the page, footer included, which the text cut to
  // PAGE_TEXT_MAX would lose.
  const key = process.env.SITE_READER_KEY;
  try {
    const res = await fetch(`${readerUrl()}${url}`, {
      headers: { accept: "text/plain", "x-timeout": "20", "x-with-links-summary": "true", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(40000),
    });
    if (res.ok) {
      const body = await res.text();
      const title = /^Title:\s*(.+)$/m.exec(body)?.[1]?.trim();
      const [content = body, summary = ""] = (body.split(/^Markdown Content:\s*$/m)[1] ?? body).split(/^Links\/Buttons:\s*$/m);
      const links = linksInText(`${content}\n${summary}`).flatMap((m) => absolute(m[1]!, url));
      // Images and bare link targets are noise to a reader summarising the page.
      const text = content
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[\s*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\((https?:[^)]*)\)/g, "$1 <$2>")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text.length >= 80) return { url, ...(title ? { title } : {}), text: text.slice(0, PAGE_TEXT_MAX), links, via: "reader" };
    }
  } catch {
    /* fall through */
  }
  return { url, text: "", links: [], via: "failed" };
}

function absolute(href: string, base: string): string[] {
  try {
    return [new URL(href, base).toString()];
  } catch {
    return [];
  }
}

/** Reads a few pages at once; never more than READ_BATCH_MAX, so a call finishes inside the route's limit. */
export async function readPages(urls: string[]): Promise<Array<Awaited<ReturnType<typeof readPage>>>> {
  return Promise.all(urls.slice(0, READ_BATCH_MAX).map((url) => readPage(url)));
}

/**
 * The part of a product's context a writer needs for one lead: every page written for the
 * lead's segment, the pages anyone might need (pricing, comparisons, security), and the
 * rest of the context as it is. A card is read for every touch, so feature pages are
 * listed without their summaries once the segment's own pages are in.
 */
export function contextForLead(context: SiteContext | undefined, segment: string | undefined): Record<string, unknown> | null {
  if (!context) return null;
  const forSegment = context.pages.filter((p) => segment && p.segments.includes(segment));
  const always = context.pages.filter((p) => ["pricing", "compare", "security", "demo"].includes(p.kind));
  const features = context.pages.filter((p) => p.kind === "feature");
  const solutions = context.pages.filter((p) => p.kind === "solution" && !forSegment.includes(p));
  const row = (p: SiteContext["pages"][number]) => ({ url: p.url, title: p.title, kind: p.kind, ...(p.summary ? { summary: p.summary } : {}), ...(p.competitor ? { competitor: p.competitor } : {}) });
  const brief = (p: SiteContext["pages"][number]) => ({ url: p.url, title: p.title, kind: p.kind });
  return {
    overview: context.overview,
    positioning: context.positioning,
    pages_for_this_lead: forSegment.map(row),
    pages: [...always.filter((p) => !forSegment.includes(p)).map(row), ...features.filter((p) => !forSegment.includes(p)).map(brief)],
    other_solution_pages: solutions.map((p) => ({ url: p.url, title: p.title })),
    competitors: context.competitors,
    proof: context.proof.map((p) => ({ text: p.text, kind: p.kind, status: p.status })),
    trust: context.trust.map((t) => t.text),
    markets: context.markets,
    read_at: context.readAt,
  };
}

/** The context stored on a product, or undefined. Loose on purpose: an old row may predate the schema. */
export function contextOf(product: Document | null | undefined): SiteContext | undefined {
  const context = (product?.config as { context?: SiteContext } | undefined)?.context;
  return context && Array.isArray(context.pages) ? context : undefined;
}

/** Days since the site was last read, or null when it never was. */
export function contextAgeDays(context: SiteContext | undefined, now = Date.now()): number | null {
  if (!context?.readAt) return null;
  const at = Date.parse(context.readAt);
  return Number.isFinite(at) ? Math.floor((now - at) / 86_400_000) : null;
}

/** How often the site is read again. A pricing change should not wait a quarter to reach the mails. */
export const CONTEXT_REFRESH_DAYS = 30;

/**
 * The link a mail's button carries when a writer picked one of the product's pages for it:
 * the page, with the person and their visit token, so the page can report the visit the
 * way the start link does (POST /api/e/<event>?p=…&s=…).
 */
export function pageLinkFor(pageUrl: string, personId: string, visitToken: string): string {
  try {
    const parsed = new URL(pageUrl);
    parsed.searchParams.set("p", personId);
    parsed.searchParams.set("s", visitToken);
    return parsed.toString();
  } catch {
    return pageUrl;
  }
}
