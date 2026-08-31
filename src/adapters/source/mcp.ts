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

    const records = extractRecords(result);
    const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    return { records, nextCursor };
  }
}

/**
 * MCP responses are shaped by the server, not by us, so the list could be at the top level
 * or under a mapped key. Anything unrecognised yields no records rather than a crash —
 * a source that returns an unexpected shape must not take down the tick.
 */
function extractRecords(result: Record<string, unknown>): RawRecord[] {
  if (Array.isArray(result.records)) return result.records as RawRecord[];
  const raw = result.raw;
  if (Array.isArray(raw)) return raw as RawRecord[];
  if (raw && typeof raw === "object") {
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) return value as RawRecord[];
    }
  }
  return [];
}
