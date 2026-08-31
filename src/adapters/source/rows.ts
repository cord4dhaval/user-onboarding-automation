import type { FetchResult, RawRecord, SourceAdapter } from "./types.js";

/**
 * For sources where the records already exist: an uploaded spreadsheet, or a webhook
 * body that was pushed to us. No fetching involved — the ingest path is shared.
 */
export class RowsAdapter implements SourceAdapter {
  constructor(private readonly rows: RawRecord[]) {}

  async fetch(): Promise<FetchResult> {
    return { records: this.rows };
  }
}
