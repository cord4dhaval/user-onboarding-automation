import type { McpClient } from "../../mcp/client.js";
import { invoke, type Binding } from "../../mcp/binding.js";
import type { FetchResult, RawRecord, SourceAdapter } from "./types.js";

/**
 * How many pages one run will walk backwards before giving up and waiting for the next.
 *
 * A bound is needed either way: a server whose cursor never terminates would otherwise
 * hold a tick open until the platform kills it. Twenty pages is far more than a ten-minute
 * poll can fall behind.
 */
const MAX_PAGES = 20;

/** Where a record's own timestamp is likely to live, in the order servers tend to use. */
const TIME_KEYS = ["submittedAt", "createdAt", "created_time", "createdTime", "recordedAt", "timestamp", "date"];

/**
 * Pulls leads through whatever tool the product's MCP happens to expose. The tool name
 * and argument mapping live in the binding, so a different product with different tool
 * names needs no code change here.
 *
 * **What the cursor means.** A lead server answers newest-first and hands back a cursor
 * meaning "carry on further back" — not "resume after this". Storing that cursor as the
 * resume point walked this product backwards through its own history, one page per poll,
 * until it reached the oldest lead in the account and then fetched nothing at all: four
 * days of new leads sat on the server untouched, and the ones it had already ingested were
 * a median of twenty days old when they were first mailed.
 *
 * So the cursor kept here is a high-water mark — the newest record ever ingested — and the
 * server's own cursor is used only to page backwards *within* a run, stopping as soon as a
 * page reaches the mark. Each run then collects exactly what arrived since the last one.
 */
export class McpSourceAdapter implements SourceAdapter {
  constructor(
    private readonly client: McpClient,
    private readonly binding: Binding,
  ) {}

  async fetch(watermark?: string): Promise<FetchResult> {
    const since = watermark ? Date.parse(watermark) : undefined;
    const records: RawRecord[] = [];
    let newest = Number.isFinite(since) ? (since as number) : 0;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await invoke(this.client, this.binding, "fetch_leads", { cursor: cursor ?? null });

      // A server that answers in text is answering normally: MCP's content blocks are text
      // by default, and plenty of servers put a human-readable prefix in front of the JSON.
      // Reading only structured fields meant such a source polled forever and ingested
      // nothing, with no error anywhere to say so.
      const body = parseBody(result);
      const page_records = extractRecords(body);
      if (page_records.length === 0) break;

      let reachedMark = false;
      for (const record of page_records) {
        const at = timeOf(record);
        if (at !== undefined && at > newest) newest = at;
        // Everything at or before the mark has been ingested already. Dedupe would drop it
        // anyway, but only after another arrival was recorded against each person.
        if (since !== undefined && at !== undefined && at <= since) {
          reachedMark = true;
          continue;
        }
        records.push(record);
      }

      const next = typeof body.nextCursor === "string" ? body.nextCursor : undefined;
      // Stop when the page reached what we already have, when the server has no more, or
      // when it repeats itself. And with no mark at all — a source being run for the first
      // time — take the newest page only rather than hoovering the entire account.
      if (reachedMark || !next || next === cursor || since === undefined) break;
      cursor = next;
    }

    return {
      records,
      // The mark, not the server's position. Undefined when nothing carried a timestamp,
      // which leaves the previous mark in place rather than resetting it to the epoch.
      nextCursor: newest > 0 ? new Date(newest).toISOString() : undefined,
    };
  }
}

/** A record's own timestamp, in milliseconds, or undefined when it has none we recognise. */
function timeOf(record: RawRecord): number | undefined {
  for (const key of TIME_KEYS) {
    const value = record[key];
    if (typeof value !== "string" && typeof value !== "number") continue;
    const at = typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/**
 * The body to read records out of, whatever form the server chose.
 *
 * A mapped result is used as-is. A text payload is cut to its first brace or bracket and
 * parsed — servers commonly prefix the JSON with a label like "leads:" — and text that
 * turns out not to be JSON is left alone rather than throwing, because an unexpected shape
 * must never take down the tick.
 */
function parseBody(result: Record<string, unknown>): Record<string, unknown> {
  const raw = result.raw;
  if (typeof raw !== "string") return result;

  const at = raw.search(/[[{]/);
  if (at === -1) return result;
  try {
    const parsed = JSON.parse(raw.slice(at)) as unknown;
    if (Array.isArray(parsed)) return { records: parsed };
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Not JSON after all. Fall through to the structured fields, which is what a
    // genuinely prose-only answer deserves: no records, no crash.
  }
  return result;
}

/**
 * MCP responses are shaped by the server, not by us, so the list could be at the top level
 * or under a mapped key. Anything unrecognised yields no records rather than a crash —
 * a source that returns an unexpected shape must not take down the tick.
 */
function extractRecords(body: Record<string, unknown>): RawRecord[] {
  if (Array.isArray(body.records)) return body.records as RawRecord[];
  const raw = body.raw;
  if (Array.isArray(raw)) return raw as RawRecord[];
  if (raw && typeof raw === "object") {
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) return value as RawRecord[];
    }
  }
  // The parsed body itself. Its record array is under whatever key the server picked —
  // "leads", "contacts", "items" — so the first array of objects is taken.
  for (const value of Object.values(body)) {
    if (Array.isArray(value) && value.every((v) => v && typeof v === "object")) {
      return value as RawRecord[];
    }
  }
  return [];
}
