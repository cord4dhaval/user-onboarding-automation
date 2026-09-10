import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";

/**
 * Pulls everything showable off a marketing site into a folder, so assets can be picked
 * from a manifest instead of guessed at by a model.
 *
 * The site is a React SPA, so a plain fetch returns an empty shell. Pages are rendered by
 * the locally installed Chrome in headless mode (`--dump-dom` after a virtual-time budget),
 * which needs no npm dependency. Each page also gets a full-height screenshot, because the
 * product UI on these pages is DOM, not an image, and a screenshot is the only way to
 * carry it into an email.
 *
 * Output, under `assets/<slug>/`:
 *   images/ logos/ icons/ svg/ video/ screenshots/   the files
 *   pages/<slug>.html                                  rendered DOM, for a second pass later
 *   manifest.json                                      every file with its page, alt, size,
 *                                                      plus quotes, stats and headings found
 *
 * Nothing here writes to the database. Import is a separate, reviewed step, because an
 * asset needs `useWhen`, `proves` and `oneLine` to be pickable, and those are written by a
 * person or a session reading the manifest, not by a crawler.
 *
 *   npx tsx src/scripts/grab-assets.ts https://teamgrid.ai teamgrid
 */

const SITE = process.argv[2] ?? "https://teamgrid.ai";
const SLUG = process.argv[3] ?? new URL(SITE).hostname.replace(/^www\./, "").split(".")[0] ?? "site";
const OUT = join(process.cwd(), "assets", SLUG);
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const MEDIA_EXT = /\.(png|jpe?g|webp|gif|svg|ico|avif|mp4|webm|mov)(\?|$)/i;

type Media = {
  url: string;
  local: string;
  kind: "image" | "logo" | "icon" | "svg" | "video" | "screenshot";
  page: string;
  alt?: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  sha1?: string;
};
type Page = { url: string; slug: string; title?: string; description?: string; h1: string[]; h2: string[]; h3: string[]; screenshot?: string; dom?: string };
type Quote = { text: string; attribution?: string; page: string };
type Stat = { value: string; label: string; page: string };

const media = new Map<string, Media>();
const pages: Page[] = [];
const quotes: Quote[] = [];
const stats: Stat[] = [];
const skipped: { url: string; reason: string }[] = [];

function log(...a: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}
function ensure(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function slugOf(url: string): string {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, "");
  return p ? p.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "home";
}
function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}
function stripTags(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "));
}

/* ---------- rendering ---------- */

function renderDom(url: string): string | null {
  const r = spawnSync(
    CHROME,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-agent=${UA}`,
      "--virtual-time-budget=10000", "--window-size=1440,900", "--dump-dom", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
  );
  if (r.status !== 0 || !r.stdout) {
    log("  dump-dom failed", url, r.status, (r.stderr ?? "").split("\n").find((l) => !l.includes("CVDisplayLink")) ?? "");
    return null;
  }
  return r.stdout;
}

function screenshot(url: string, file: string): boolean {
  const r = spawnSync(
    CHROME,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-agent=${UA}`,
      "--virtual-time-budget=10000", "--window-size=1440,6000", `--screenshot=${file}`, url],
    { encoding: "utf8", timeout: 90_000 },
  );
  return r.status === 0 && existsSync(file);
}

function dims(file: string): { width?: number; height?: number } {
  const r = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  const w = /pixelWidth:\s*(\d+)/.exec(r.stdout ?? "")?.[1];
  const h = /pixelHeight:\s*(\d+)/.exec(r.stdout ?? "")?.[1];
  return { width: w ? Number(w) : undefined, height: h ? Number(h) : undefined };
}

/* ---------- extraction ---------- */

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z-:]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[(m[1] ?? "").toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

function kindOf(url: string, ctx: string): Media["kind"] {
  const p = new URL(url).pathname.toLowerCase();
  if (/\.(mp4|webm|mov)$/.test(p)) return "video";
  if (/favicon|apple-touch|icon|manifest/.test(p) || ctx === "icon") return "icon";
  if (/logo|\/logos\/|mark-/.test(p) || /logo/i.test(ctx)) return "logo";
  if (/\.svg$/.test(p)) return "svg";
  return "image";
}

function addMedia(raw: string, page: string, ctx: string, alt?: string) {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return;
  let url: string;
  try { url = new URL(raw, page).toString(); } catch { return; }
  if (!MEDIA_EXT.test(new URL(url).pathname)) return;
  if (new URL(url).hostname.includes("googletagmanager") || url.includes("clarity.ms")) return;
  const cur = media.get(url);
  if (cur) { if (!cur.alt && alt) cur.alt = alt; return; }
  media.set(url, { url, local: "", kind: kindOf(url, ctx), page, alt: alt || undefined });
}

function extractFromDom(html: string, page: string) {
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    addMedia(a.src ?? a["data-src"] ?? "", page, "img", a.alt);
    for (const cand of (a.srcset ?? a["data-srcset"] ?? "").split(",")) addMedia(cand.trim().split(/\s+/)[0] ?? "", page, "img", a.alt);
  }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    addMedia(a.src ?? "", page, "source");
    for (const cand of (a.srcset ?? "").split(",")) addMedia(cand.trim().split(/\s+/)[0] ?? "", page, "source");
  }
  for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    addMedia(a.src ?? "", page, "video");
    addMedia(a.poster ?? "", page, "poster");
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/icon|image/i.test(a.rel ?? "") || /image/.test(a.as ?? "")) addMedia(a.href ?? "", page, "icon");
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/og:image|twitter:image/i.test(a.property ?? a.name ?? "")) addMedia(a.content ?? "", page, "og");
  }
  for (const m of html.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) addMedia(m[2] ?? "", page, "css");
  for (const m of html.matchAll(/(?:href|src)=["']([^"']+\.(?:png|jpe?g|webp|gif|svg|mp4|webm))["']/gi)) addMedia(m[1] ?? "", page, "attr");

  // Inline SVG is the logo more often than not on a React site, and it is not a URL.
  let n = 0;
  for (const m of html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
    const svg = m[0];
    if (svg.length < 400 || svg.length > 200_000) continue;
    const sha = createHash("sha1").update(svg).digest("hex").slice(0, 10);
    const key = `inline-svg:${sha}`;
    if (media.has(key)) continue;
    ensure(join(OUT, "svg"));
    const local = join("svg", `${slugOf(page)}-inline-${++n}-${sha}.svg`);
    writeFileSync(join(OUT, local), svg.includes("xmlns=") ? svg : svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"'));
    media.set(key, { url: key, local, kind: "svg", page, bytes: svg.length, sha1: sha, alt: attrs(svg.slice(0, svg.indexOf(">")))["aria-label"] });
  }
}

function headings(html: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))) {
    const t = stripTags(m[1] ?? "");
    if (t && t.length < 200 && !out.includes(t)) out.push(t);
  }
  return out;
}

function meta(html: string, name: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.name ?? a.property ?? "").toLowerCase() === name) return a.content;
  }
  return undefined;
}

/** Text as lines at tag boundaries, which is enough to find a stat tile or a testimonial. */
function textLines(html: string): string[] {
  const body = html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ");
  return body.split(/<[^>]+>/).map(decode).filter(Boolean);
}

function extractText(html: string, page: string) {
  const lines = textLines(html);
  const stat = /^[+<>~]?\d[\d.,]*\s?(%|h|hrs?|x|×|M\+|K\+|\+|mo|min|days?|s)?$/i;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] ?? "";
    if (l.length <= 8 && stat.test(l) && /\d/.test(l)) {
      const label = [lines[i + 1], lines[i + 2]].filter((x) => x && x.length < 140 && !stat.test(x)).join(" — ");
      if (label && !stats.some((s) => s.value === l && s.label === label)) stats.push({ value: l, label, page });
    }
    const q = /^[“"']?(.{40,400}?)[”"']$/.exec(l);
    if (q && /^[“"]/.test(l)) {
      const attribution = [lines[i + 1], lines[i + 2]].filter((x) => x && x.length < 80 && !/^[“"]/.test(x)).join(" · ");
      const qt = q[1] ?? ""; if (qt && !quotes.some((x) => x.text === qt)) quotes.push({ text: qt, attribution: attribution || undefined, page });
    }
  }
}

/* ---------- downloading ---------- */

function localNameFor(url: string, kind: Media["kind"]): string {
  const u = new URL(url);
  const base = basename(u.pathname) || "file";
  const clean = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const dir = kind === "video" ? "video" : kind === "screenshot" ? "screenshots" : kind === "icon" ? "icons" : kind === "logo" ? "logos" : kind === "svg" ? "svg" : "images";
  ensure(join(OUT, dir));
  let name = clean;
  if (existsSync(join(OUT, dir, name))) name = `${createHash("sha1").update(url).digest("hex").slice(0, 6)}-${clean}`;
  return join(dir, name);
}

async function download(m: Media): Promise<void> {
  if (m.url.startsWith("inline-svg:")) return;
  try {
    const res = await fetch(m.url, { headers: { "user-agent": UA, referer: SITE }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { skipped.push({ url: m.url, reason: `HTTP ${res.status}` }); media.delete(m.url); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get("content-type")?.split(";")[0] ?? undefined;
    if (mime && !/^(image|video)\//.test(mime)) { skipped.push({ url: m.url, reason: `not media: ${mime}` }); media.delete(m.url); return; }
    m.local = localNameFor(m.url, m.kind);
    writeFileSync(join(OUT, m.local), buf);
    m.mime = mime;
    m.bytes = buf.length;
    m.sha1 = createHash("sha1").update(buf).digest("hex").slice(0, 10);
    if (/^image\/(png|jpe?g|webp|gif)/.test(mime ?? "") || /\.(png|jpe?g|webp|gif)$/i.test(m.local)) Object.assign(m, dims(join(OUT, m.local)));
  } catch (err) {
    skipped.push({ url: m.url, reason: String((err as Error).message ?? err) });
    media.delete(m.url);
  }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++] as T); }));
}

/* ---------- discovery ---------- */

async function sitemapPages(): Promise<string[]> {
  try {
    const xml = await (await fetch(new URL("/sitemap.xml", SITE), { headers: { "user-agent": UA } })).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1] ?? ""));
    if (locs.length) return locs;
  } catch { /* fall through */ }
  return [SITE];
}

/** Media the bundle knows about but no crawled page happened to show. */
async function bundleMedia(homeHtml: string) {
  const scripts = [...homeHtml.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map((m) => new URL(m[1] ?? "", SITE).toString()).filter((u) => new URL(u).hostname === new URL(SITE).hostname);
  const known = new Set([...media.keys()].map((u) => { try { return new URL(u).pathname.toLowerCase(); } catch { return u; } }));
  const prefixes = ["", "/assets", "/assets/images", "/assets/logos", "/assets/icons", "/assets/img", "/images", "/img", "/static/media", "/media"];
  const candidates = new Set<string>();
  for (const s of scripts) {
    let js = "";
    try { js = await (await fetch(s, { headers: { "user-agent": UA } })).text(); } catch { continue; }
    for (const m of js.matchAll(/["'`](\/?[A-Za-z0-9_./+()-]+\.(?:png|jpe?g|webp|gif|svg|mp4|webm))["'`]/g)) {
      const raw = m[1] ?? ""; const p = raw.startsWith("/") ? raw : `/${raw}`;
      if (!p.startsWith("/.") && !p.includes("..")) candidates.add(p);
    }
  }
  log(`bundle: ${candidates.size} media paths referenced in ${scripts.length} script(s)`);
  const found: string[] = [];
  await pool([...candidates], 8, async (p) => {
    for (const pre of prefixes) {
      const url = new URL(pre + p, SITE).toString();
      if (known.has(new URL(url).pathname.toLowerCase())) return;
      try {
        const r = await fetch(url, { method: "HEAD", headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
        if (r.ok && /^(image|video)\//.test(r.headers.get("content-type") ?? "")) { addMedia(url, SITE, "bundle"); found.push(url); return; }
      } catch { /* try next prefix */ }
    }
  });
  log(`bundle: ${found.length} extra files located`);
}

/* ---------- main ---------- */

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_BIN`);
  ensure(OUT);
  ensure(join(OUT, "pages"));
  ensure(join(OUT, "screenshots"));
  log(`site ${SITE} -> ${OUT}`);

  const urls = await sitemapPages();
  log(`${urls.length} pages from sitemap`);

  let homeHtml = "";
  for (const url of urls) {
    const slug = slugOf(url);
    log(`page ${slug}`);
    const html = renderDom(url);
    if (!html) { pages.push({ url, slug, h1: [], h2: [], h3: [] }); continue; }
    if (url.replace(/\/$/, "") === SITE.replace(/\/$/, "")) homeHtml = html;
    writeFileSync(join(OUT, "pages", `${slug}.html`), html);
    extractFromDom(html, url);
    extractText(html, url);
    const shot = join("screenshots", `${slug}.png`);
    const ok = screenshot(url, join(OUT, shot));
    if (ok) {
      const d = dims(join(OUT, shot));
      media.set(`screenshot:${url}`, { url: `screenshot:${url}`, local: shot, kind: "screenshot", page: url, ...d, bytes: readFileSync(join(OUT, shot)).length });
    }
    pages.push({
      url, slug,
      title: stripTags(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""),
      description: meta(html, "description") ?? meta(html, "og:description"),
      h1: headings(html, "h1"), h2: headings(html, "h2"), h3: headings(html, "h3"),
      screenshot: ok ? shot : undefined,
      dom: join("pages", `${slug}.html`),
    });
  }

  if (!homeHtml) homeHtml = await (await fetch(SITE, { headers: { "user-agent": UA } })).text();
  await bundleMedia(homeHtml);

  const toGet = [...media.values()].filter((m) => !m.local);
  log(`downloading ${toGet.length} files`);
  await pool(toGet, 6, download);

  const manifest = {
    site: SITE,
    crawledAt: new Date().toISOString(),
    counts: {
      pages: pages.length,
      media: media.size,
      byKind: [...media.values()].reduce<Record<string, number>>((acc, m) => ((acc[m.kind] = (acc[m.kind] ?? 0) + 1), acc), {}),
      quotes: quotes.length,
      stats: stats.length,
      skipped: skipped.length,
    },
    pages,
    media: [...media.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.local.localeCompare(b.local)),
    quotes,
    stats,
    skipped,
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  log("done", JSON.stringify(manifest.counts));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
