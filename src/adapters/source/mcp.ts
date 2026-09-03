import type { McpClient } from "../../mcp/client.js";
import { invoke, type Binding } from "../../mcp/binding.js";
import type { FetchResult, RawRecord, SourceAdapter } from "./types.js";

/**
 * Pulls leads through whatever tool the product's MCP happens to expose. The tool name
 * and argument mapping live in the binding, so a different product with different tool
 * names needs no code change here.
 */
export class McpSourceAdapter implements SourceAdapter {
  constructor(
    private readonly client: McpClient,
    private readonly binding: Binding,
  ) {}

  async fetch(cursor?: string): Promise<FetchResult> {
    const result = await invoke(this.client, this.binding, "fetch_leads", { cursor: cursor ?? null });

    // A server that answers in text is answering normally: MCP's content blocks are text
    // by default, and plenty of servers put a human-readable prefix in front of the JSON.
    // Reading only structured fields meant such a source polled forever and ingested
    // nothing, with no error anywhere to say so.
    const body = parseBody(result);
    const records = extractRecords(body);
    const nextCursor = typeof body.nextCursor === "string" ? body.nextCursor : undefined;
    return { records, nextCursor };
  }
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
