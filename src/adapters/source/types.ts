/** One record as it arrives from a source, before field mapping. */
export type RawRecord = Record<string, unknown>;

export interface FetchResult {
  records: RawRecord[];
  /**
   * Where to carry on from next time. Persisted only after every record is committed.
   *
   * Adapters over a newest-first feed return a high-water mark — the newest record they
   * have seen — rather than the server's own paging token, because those tokens mean
   * "further back" and storing one as the resume point walks the source into its own
   * history instead of forward into new arrivals.
   */
  nextCursor?: string;
}

/**
 * Every source shape reduces to this. Excel, webhook push and MCP differ only in how
 * records arrive; everything downstream is identical.
 */
export interface SourceAdapter {
  fetch(cursor?: string): Promise<FetchResult>;
}
