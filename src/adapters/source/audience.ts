import { audienceMembers } from "../../engine/library.js";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { ObjectId } from "mongodb";
import type { FetchResult, RawRecord, SourceAdapter } from "./types.js";

/**
 * Reads people back out of the library.
 *
 * The loop this closes is the point of the whole design: campaigns write people in as they
 * arrive, and audiences feed them back into new campaigns — so nobody falls out of the
 * system when a campaign ends. A dynamic audience means the campaign never runs dry.
 */
export class AudienceSourceAdapter implements SourceAdapter {
  constructor(
    private readonly orgId: string,
    private readonly productId: string,
    private readonly audienceId: string,
  ) {}

  async fetch(): Promise<FetchResult> {
    const ids = await audienceMembers(this.orgId, this.productId, this.audienceId);
    if (ids.length === 0) return { records: [] };

    const db = await getDb();
    const people = await db
      .collection(C.people)
      .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
      .toArray();

    // Emitted in our own shape, so ingest dedupes them straight back onto the same records
    // rather than creating second copies of people it already knows.
    const records: RawRecord[] = people.map((p) => ({
      email: String(p.primaryEmail ?? ""),
      name: p.name ?? "",
      role: p.role ?? "",
      company_domain: p.companyDomain ?? "",
      timezone: p.timezone ?? "UTC",
    }));

    return { records };
  }
}
