import type { FetchResult, RawRecord, SourceAdapter } from "./types.js";

/**
 * Plain HTTP source: GET an endpoint with a bearer token and read an array out of the
 * response. Covers the "API + token" case where a product has no MCP server.
 */
export class HttpSourceAdapter implements SourceAdapter {
  constructor(
    private readonly url: string,
    private readonly token: string,
    /** Optional query parameter used to resume from the last position. */
    private readonly cursorParam?: string,
  ) {}

  async fetch(cursor?: string): Promise<FetchResult> {
    const url = new URL(this.url);
    if (cursor && this.cursorParam) url.searchParams.set(this.cursorParam, cursor);

    const res = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    // Error bodies from APIs routinely echo the token back; report the status only.
    if (!res.ok) throw new Error(`source fetch failed: HTTP ${res.status}`);

    // A URL missing its path returns the site's own HTML, and JSON.parse then reports a
    // stray "<" — which reads as a broken API rather than the wrong address it is.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new Error(
        `source returned ${contentType.split(";")[0] || "an unknown type"}, not JSON — check the endpoint URL`,
      );
    }

    const body = (await res.json().catch(() => {
      throw new Error("source returned a body that is not valid JSON");
    })) as unknown;
    return { records: extractRecords(body), nextCursor: extractCursor(body) };
  }
}

/** The array could be at the top level or under any key; take the first one found. */
function extractRecords(body: unknown): RawRecord[] {
  if (Array.isArray(body)) return body as RawRecord[];
  if (body && typeof body === "object") {
    for (const key of ["data", "results", "items", "records", "leads", "contacts"]) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as RawRecord[];
    }
    for (const value of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(value)) return value as RawRecord[];
    }
  }
  return [];
}

function extractCursor(body: unknown): string | undefined {
  if (!body || typeof body === "object") {
    const record = body as Record<string, unknown> | null;
    for (const key of ["nextCursor", "next_cursor", "cursor", "next"]) {
      const value = record?.[key];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}
