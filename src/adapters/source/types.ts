/** One record as it arrives from a source, before field mapping. */
export type RawRecord = Record<string, unknown>;

export interface FetchResult {
  records: RawRecord[];
  /** Opaque position to resume from. Persisted only after every record is committed. */
  nextCursor?: string;
}

/**
 * Every source shape reduces to this. Excel, webhook push and MCP differ only in how
 * records arrive; everything downstream is identical.
 */
export interface SourceAdapter {
  fetch(cursor?: string): Promise<FetchResult>;
}
