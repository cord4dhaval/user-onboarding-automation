import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";

/**
 * Screenshots of the product itself, taken from a browser a person has already signed
 * in to.
 *
 * The sign-in is theirs, not ours: this script never sees a password. Start Chrome with a
 * remote debugging port and a profile of its own, log in there, then run this. It attaches
 * to that one tab over the DevTools protocol and nothing else — attaching to the whole
 * browser stalls on third-party iframes (Stripe, Google) that never answer, which is why
 * this speaks the protocol directly instead of through a driver.
 *
 * For every screen it saves a first-screen shot, a full-page shot, the large blocks on
 * the page as separate crops, and every image the page loads. A manifest ties each file
 * to the route and heading it came from so an asset can be written against it later.
 *
 * The account is real, so the page is anonymised before every capture: names found in
 * people-shaped elements are swapped for a fixed set of invented ones, emails and phone
 * numbers are masked, the account's own company is renamed, and avatar images are
 * blurred and never downloaded. The same real name maps to the same invented one on
 * every screen, so a member list and the report about that member still agree. The
 * in-page code lives beside this file in `grab-app-page/`.
 *
 *   open -na "Google Chrome" --args --user-data-dir=$HOME/.cache/teamgrid-onboarding/chrome-profile \
 *        --remote-debugging-port=9333 https://teamgrid.ai/login
 *   ACCOUNT_EMAIL=you@company.com npx tsx src/scripts/grab-app-screens.ts            # discover routes
 *   ACCOUNT_EMAIL=you@company.com npx tsx src/scripts/grab-app-screens.ts /dashboard  # or name them
 *
 * Nothing here writes to the database.
 */

const PORT = Number(process.env.CDP_PORT ?? 9333);
const SLUG = process.env.SITE_SLUG ?? "teamgrid";
const OUT = join(process.cwd(), "assets", SLUG, "app");
const MAX_ROUTES = Number(process.env.MAX_ROUTES ?? 40);
const VIEW = { width: 1440, height: 900 };
const routesArg = process.argv.slice(2);
const PAGE_DIR = join(import.meta.dirname, "grab-app-page");
const script = (name: string) => readFileSync(join(PAGE_DIR, `${name}.js`), "utf8");

const FIRSTS = ["Aarav", "Diya", "Kabir", "Ishita", "Rohan", "Meera", "Vihaan", "Anaya", "Arjun", "Sara", "Dev", "Nia", "Yash", "Tara", "Zoya", "Rehan", "Kiara", "Aditya", "Mira", "Neil", "Priya", "Omar", "Sahil", "Leah", "Tanvi", "Ravi", "Esha"];
const LASTS = ["Mehta", "Kapoor", "Nair", "Rao", "Iyer", "Joshi", "Shah", "Bose", "Pillai", "Menon", "Malhotra", "Reddy", "Verma", "Sinha", "Khan", "Das", "Gill", "Roy", "Chawla", "Bhatt", "Sen", "Sheikh", "Anand", "Jain"];
/** Firsts and lasts walked with a stride so the first hundred pairs all read as different people. */
const FAKE_NAMES = Array.from({ length: FIRSTS.length * LASTS.length }, (_, i) => `${FIRSTS[i % FIRSTS.length]} ${LASTS[(i * 7 + Math.floor(i / FIRSTS.length)) % LASTS.length]}`);
const FAKE_COMPANY = "Northwind Studio";
let nameMap: Record<string, string> = {};
const leaksSeen: Record<string, number> = {};

/** What the signed-in account calls itself: its email's local part and company domain. */
function accountHintsFrom(email: string | undefined): string[] {
  if (!email) return [];
  const [local = "", domain = ""] = email.split("@");
  const first = local.split(/[._-]/)[0] ?? "";
  const company = domain.split(".")[0] ?? "";
  return [first ? first[0]!.toUpperCase() + first.slice(1) : "", company, domain].filter(Boolean);
}
const ACCOUNT_HINTS = accountHintsFrom(process.env.ACCOUNT_EMAIL);

type Shot = { route: string; kind: "full" | "viewport" | "block" | "image"; local: string; label?: string; width?: number; height?: number; bytes?: number; url?: string; alt?: string };
type Screen = { route: string; url: string; title: string; h1: string[]; h2: string[]; nav: string[]; shots: string[] };
const shots: Shot[] = [];
const screens: Screen[] = [];

function log(...a: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}
function ensure(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function slugOf(route: string): string {
  return route.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "home";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- a very small DevTools client ---------- */

class Tab {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  static async attach(port: number): Promise<{ tab: Tab; url: string }> {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const page = list.find((t) => t.type === "page" && /^https?:\/\//.test(t.url) && !/login|register/i.test(t.url)) ?? list.find((t) => t.type === "page" && /^https?:\/\//.test(t.url));
    if (!page) throw new Error(`no signed-in app tab on port ${port}; open the app there first`);
    const tab = new Tab();
    await new Promise<void>((resolve, reject) => {
      tab.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      tab.ws.once("open", () => resolve());
      tab.ws.once("error", (e) => reject(e));
      tab.ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
        if (msg.id !== undefined) {
          const p = tab.pending.get(msg.id);
          if (!p) return;
          tab.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method) {
          for (const cb of tab.listeners.get(msg.method) ?? []) cb(msg.params ?? {});
        }
      });
    });
    return { tab, url: page.url };
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, cb: (params: Record<string, unknown>) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), cb]);
  }

  /** Evaluate an expression in the page; promises are awaited; the value comes back as JSON. */
  async eval<T = unknown>(expression: string, timeoutMs = 60_000): Promise<T> {
    const r = await this.send<{ result: { value?: T; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async viewport(width: number, height: number) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  }

  async navigate(url: string) {
    const loaded = new Promise<void>((resolve) => this.on("Page.loadEventFired", () => resolve()));
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(20_000)]);
  }

  async png(file: string, clip?: { x: number; y: number; width: number; height: number }) {
    const leaks = await this.eval<string[]>("window.__grabScrub ? window.__grabScrub() : []").catch(() => [] as string[]);
    for (const l of leaks) { leaksSeen[l] = (leaksSeen[l] ?? 0) + 1; log(`  still visible before capture: "${l}"`); }
    const r = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    }, 120_000);
    const buf = Buffer.from(r.data, "base64");
    writeFileSync(file, buf);
    return buf.length;
  }

  close() {
    this.ws.close();
  }
}

/* ---------- per-screen work ---------- */

async function settle(tab: Tab): Promise<number> {
  await sleep(1200);
  const h = await tab.eval<number>(script("settle"));
  await sleep(400);
  return h;
}

/** REPLACE="Grow8=Atlas,MeBetter=Beacon": project or client names to swap on every screen. */
const EXTRA: Record<string, string> = Object.fromEntries(
  (process.env.REPLACE ?? "").split(",").map((pair) => pair.split("=").map((x) => x.trim())).filter((kv): kv is [string, string] => kv.length === 2 && !!kv[0] && !!kv[1]),
);
async function anonymize(tab: Tab) {
  await tab.eval(`window.__grab = ${JSON.stringify({ map: nameMap, fakes: FAKE_NAMES, company: FAKE_COMPANY, hints: ACCOUNT_HINTS, extra: EXTRA })}; true`);
  const r = await tab.eval<{ map: Record<string, string>; leaks: string[] }>(script("anonymize"));
  nameMap = r.map;
  for (const l of r.leaks) {
    leaksSeen[l] = (leaksSeen[l] ?? 0) + 1;
    log(`  still visible after scrub: "${l}"`);
  }
}

async function discoverRoutes(tab: Tab, origin: string): Promise<string[]> {
  const hrefs = await tab.eval<{ href: string; text: string }[]>(script("links"));
  const routes = new Set<string>();
  for (const { href } of hrefs) {
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (u.origin !== origin) continue;
    const path = u.pathname.replace(/\/$/, "") || "/";
    if (/logout|sign-?out|login|register|\.(pdf|png|jpg)$/i.test(path)) continue;
    routes.add(path);
  }
  return [...routes];
}

/** Routes reachable by clicking the app's own navigation, for menus built without hrefs. */
async function discoverByClicking(tab: Tab, origin: string, home: string, known: string[]): Promise<string[]> {
  const sel = "nav a, nav button, nav li, aside a, aside button, aside li, [class*=sidebar i] a, [class*=sidebar i] button, [class*=sidebar i] li, [class*=nav i] a, [class*=nav i] button, [role=menuitem], [role=tab]";
  const count = await tab.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const found = new Set(known);
  for (let i = 0; i < Math.min(count, 60); i += 1) {
    try {
      await tab.eval(`window.__grabClick = ${JSON.stringify({ sel, i })}; true`);
      const label = await tab.eval<string | null>(script("click"));
      if (label === null) continue;
      await sleep(1200);
      const here = await tab.eval<string>("location.href");
      const u = new URL(here);
      if (u.origin === origin) {
        const path = u.pathname.replace(/\/$/, "") || "/";
        if (!found.has(path) && !/login|register|logout/i.test(path)) { found.add(path); log(`  nav "${label}" -> ${path}`); }
      }
      if (here !== home) {
        await tab.navigate(home);
        await settle(tab);
      }
    } catch { /* a menu item that opens a dialog or leaves; move on */ }
  }
  return [...found];
}

async function captureBlocks(tab: Tab, route: string) {
  const blocks = await tab.eval<{ x: number; y: number; w: number; h: number; label: string }[]>(script("blocks"));
  ensure(join(OUT, "blocks"));
  let n = 0;
  for (const b of blocks) {
    n += 1;
    const tag = b.label ? "-" + b.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 30) : "";
    const local = join("blocks", `${slugOf(route)}-${String(n).padStart(2, "0")}${tag}.png`);
    try {
      const bytes = await tab.png(join(OUT, local), { x: b.x, y: b.y, width: b.w, height: b.h });
      // A few kilobytes of PNG at this size is a flat rectangle: a section that had not loaded.
      if (bytes < 12_000) { unlinkSync(join(OUT, local)); continue; }
      shots.push({ route, kind: "block", local, label: b.label || undefined, width: Math.round(b.w), height: Math.round(b.h), bytes });
    } catch { /* clip off-page; skip */ }
  }
}

const seenImages = new Set<string>();
async function captureImages(tab: Tab, route: string) {
  const imgs = await tab.eval<{ src: string; alt: string; w: number; h: number; mime: string; b64: string }[]>(script("images"), 120_000);
  const dir = join(OUT, "images");
  ensure(dir);
  for (const im of imgs) {
    if (seenImages.has(im.src)) continue;
    seenImages.add(im.src);
    const buf = Buffer.from(im.b64, "base64");
    const ext = im.mime.split("/")[1]?.replace("svg+xml", "svg").replace("jpeg", "jpg") ?? "bin";
    let name = basename(new URL(im.src).pathname).replace(/[^a-zA-Z0-9._-]+/g, "_") || "image";
    if (!name.includes(".")) name += `.${ext}`;
    if (existsSync(join(dir, name))) name = `${createHash("sha1").update(im.src).digest("hex").slice(0, 6)}-${name}`;
    writeFileSync(join(dir, name), buf);
    shots.push({ route, kind: "image", local: join("images", name), url: im.src, alt: im.alt || undefined, width: im.w || undefined, height: im.h || undefined, bytes: buf.length });
  }
}

async function captureRoute(tab: Tab, origin: string, route: string) {
  log(`screen ${route}`);
  await tab.viewport(VIEW.width, VIEW.height);
  await tab.navigate(origin + route);
  const fullHeight = await settle(tab);
  const finalUrl = await tab.eval<string>("location.href");
  if (!finalUrl.startsWith(origin) || /login|sign-?in/i.test(new URL(finalUrl).pathname)) {
    log(`  bounced to ${finalUrl}, not signed in?`);
    return;
  }
  await anonymize(tab);
  await sleep(2000); // late sections (stories, alerts) land after first paint; the observer scrubs them

  const slug = slugOf(route);
  ensure(join(OUT, "screens"));
  const view = join("screens", `${slug}.png`);
  const full = join("screens", `${slug}-full.png`);
  let bytes = await tab.png(join(OUT, view));
  shots.push({ route, kind: "viewport", local: view, width: VIEW.width, height: VIEW.height, bytes });

  // Grow the viewport to the page so full-page and block clips are in page coordinates.
  const h = Math.min(Math.max(fullHeight, VIEW.height), 8000);
  await tab.viewport(VIEW.width, h);
  await sleep(1500);
  await tab.eval(script("settle"));
  await sleep(800);
  await anonymize(tab); // sections that mounted on resize
  bytes = await tab.png(join(OUT, full), { x: 0, y: 0, width: VIEW.width, height: h });
  shots.push({ route, kind: "full", local: full, width: VIEW.width, height: h, bytes });
  await captureBlocks(tab, route);
  await tab.viewport(VIEW.width, VIEW.height);

  const info = await tab.eval<{ title: string; h1: string[]; h2: string[]; nav: string[] }>(script("info"));
  await captureImages(tab, route);
  screens.push({ route, url: finalUrl, ...info, shots: shots.filter((s) => s.route === route).map((s) => s.local) });
}

async function main() {
  ensure(OUT);
  log(`attaching to the app tab on port ${PORT}, output ${OUT}`);
  const { tab, url } = await Tab.attach(PORT);
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  const origin = new URL(url).origin;
  log(`attached to ${url}`);

  // Discovery starts from the app's home, not from wherever the tab was left: a sub-module
  // with its own sidebar (tasks, CRM) would otherwise look like the whole product.
  const start = process.env.START_PATH ?? "/dashboard";
  await tab.viewport(VIEW.width, VIEW.height);
  await tab.navigate(origin + start);
  await settle(tab);
  let routes = routesArg.length ? routesArg : await discoverRoutes(tab, origin);
  if (!routesArg.length) {
    log("clicking through the navigation as well");
    routes = await discoverByClicking(tab, origin, origin + start, routes);
  }
  if (!routes.includes(start)) routes.push(start);
  // Screens that list people go first, so every name is known before the dashboard is shot.
  const peopleFirst = (r: string) => (/team|member|people|employee|org|user|staff|directory/i.test(r) ? 0 : 1);
  routes = routes.sort((a, b) => peopleFirst(a) - peopleFirst(b)).slice(0, MAX_ROUTES);
  log(`${routes.length} routes: ${routes.join(" ")}`);

  const done = new Set<string>();
  for (const route of routes) {
    if (done.has(route)) continue;
    done.add(route);
    try {
      await captureRoute(tab, origin, route);
      if (!routesArg.length) {
        for (const r of await discoverRoutes(tab, origin)) if (!done.has(r) && routes.length < MAX_ROUTES && !routes.includes(r)) routes.push(r);
      }
    } catch (err) {
      log(`  failed ${route}: ${String((err as Error).message ?? err)}`);
    }
  }

  const manifest = {
    origin,
    capturedAt: new Date().toISOString(),
    anonymised: { names: Object.keys(nameMap).length, company: FAKE_COMPANY, extra: Object.keys(EXTRA), leaks: leaksSeen },
    counts: { screens: screens.length, shots: shots.length, byKind: shots.reduce<Record<string, number>>((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {}) },
    screens,
    shots,
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  log("done", JSON.stringify(manifest.counts));
  await tab.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  await tab.navigate(origin + start).catch(() => undefined); // leave the tab where it started
  tab.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
