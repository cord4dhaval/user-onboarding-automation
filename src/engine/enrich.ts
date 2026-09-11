import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * One read of the lead's own website, at arrival, kept as plain text on the person.
 *
 * This is the only material a session has for the opening line of a message: what the
 * company says it does, how big it is, where it is. Read once, here, by the engine — a
 * routine has no browser, and "look them up" is the step that was silently skipped for
 * every lead so far, which is why every founder got the same founder mail.
 *
 * Two thousand characters is enough for a hook and cheap enough to keep on the row. A
 * site that does not answer in six seconds is recorded as unreachable, not retried in the
 * ingest path; a spreadsheet of eight hundred rows cannot wait on eight hundred slow hosts.
 */
const UA = "Mozilla/5.0 (compatible; conversion-engine/1.0; +https://teamgrid.ai)";
const KEEP = 2000;

export function siteUrlFrom(domain: unknown): string | null {
  const raw = String(domain ?? "").trim().toLowerCase();
  if (!raw || raw === "www.abc.com" || raw.endsWith("example.com")) return null;
  const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\.?(?=[a-z0-9])/, (m) => (m === "www." ? "" : "www"));
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return `https://${host}`;
}

export function textFromHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;|&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function readSite(url: string, timeoutMs = 6000): Promise<{ text: string; title?: string } | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400_000);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
    const text = textFromHtml(html).slice(0, KEEP);
    if (text.length < 80) return null;
    return { text, title };
  } catch {
    return null;
  }
}

/** Reads every person's site, a few at a time, and writes what it found. Never throws. */
export async function readSitesFor(people: Document[], concurrency = 5): Promise<{ read: number; unreachable: number; skipped: number }> {
  const db = await getDb();
  const out = { read: 0, unreachable: 0, skipped: 0 };
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < people.length) {
        const person = people[i++]!;
        const url = siteUrlFrom(person.companyDomain);
        if (!url) { out.skipped++; continue; }
        const found = await readSite(url);
        const set: Record<string, unknown> = { "enrichment.siteUrl": url, "enrichment.siteFetchedAt": new Date() };
        if (found) { set["enrichment.siteText"] = found.text; if (found.title) set["enrichment.siteTitle"] = found.title; out.read++; }
        else { set["enrichment.siteUnreachable"] = true; out.unreachable++; }
        await db.collection(C.people).updateOne({ _id: person._id instanceof ObjectId ? person._id : new ObjectId(String(person._id)) }, { $set: set });
      }
    }),
  );
  return out;
}
