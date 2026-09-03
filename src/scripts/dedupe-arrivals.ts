import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Collapses the arrivals a cursorless poll recorded against itself.
 *
 * A polling source with no cursor returns its whole result set every run, and until rows
 * carried a fingerprint every pass was written down as a fresh arrival. One record reached
 * 229 copies of a single event. "Three arrivals means they keep circling" stops meaning
 * anything when the number really counts how long the poller has been running.
 *
 * What it keeps, and why it is not simply "keep one":
 *
 *   - every arrival that carries a fingerprint. Those are already correct.
 *   - every arrival from an upload. A spreadsheet loaded twice is a person who really did
 *     arrive twice, and that is a human action nobody should be second-guessing here.
 *   - the earliest un-fingerprinted poll arrival per source per day. Coming back on three
 *     separate days is the signal worth keeping; coming back every five minutes on one day
 *     is the poller talking to itself.
 *
 * Run with --apply. Without it, nothing is written.
 */

interface Arrival {
  sourceId?: string;
  kind?: string;
  at?: Date;
  detail?: string;
  fingerprint?: string;
}

const day = (at: unknown): string => new Date(String(at)).toISOString().slice(0, 10);

/** Kept in date order, because the timeline reads top to bottom. */
function collapse(arrivals: Arrival[], pollSources: Set<string>): Arrival[] {
  const keptDays = new Set<string>();
  const out: Arrival[] = [];

  for (const a of [...arrivals].sort((x, y) => new Date(String(x.at)).getTime() - new Date(String(y.at)).getTime())) {
    const sourceId = String(a.sourceId ?? "");
    if (a.fingerprint || !pollSources.has(sourceId)) {
      out.push(a);
      continue;
    }
    const key = `${sourceId}|${day(a.at)}`;
    if (keptDays.has(key)) continue;
    keptDays.add(key);
    out.push(a);
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const sources = await db.collection(C.sources).find({}, { projection: { kind: 1 } }).toArray();
  const pollSources = new Set(
    sources.filter((s) => String(s.kind) !== "excel_upload").map((s) => String(s._id)),
  );

  const people = await db
    .collection(C.people)
    .find({ "arrivals.1": { $exists: true } }, { projection: { arrivals: 1, primaryEmail: 1 } })
    .toArray();

  let before = 0;
  let after = 0;
  let worstBefore = 0;
  let worstAfter = 0;
  const writes = [];

  for (const person of people) {
    const arrivals = (person.arrivals ?? []) as Arrival[];
    const kept = collapse(arrivals, pollSources);
    before += arrivals.length;
    after += kept.length;
    worstBefore = Math.max(worstBefore, arrivals.length);
    worstAfter = Math.max(worstAfter, kept.length);
    if (kept.length === arrivals.length) continue;
    writes.push({ updateOne: { filter: { _id: person._id }, update: { $set: { arrivals: kept } } } });
  }

  console.log(`people with 2+ arrivals   ${people.length}`);
  console.log(`arrivals                  ${before} → ${after}`);
  console.log(`worst single record       ${worstBefore} → ${worstAfter}`);
  console.log(`records to rewrite        ${writes.length}`);

  if (writes.length === 0) {
    console.log("\nnothing to do — no poll recorded itself twice in a day.");
    process.exit(0);
  }
  if (!apply) {
    console.log("\nnothing written. re-run with:  npm run dedupe:arrivals -- --apply");
    console.log("(the bare -- matters; without it npm keeps the flag for itself)");
    process.exit(0);
  }

  await db.collection(C.people).bulkWrite(writes, { ordered: false });
  console.log(`\nrewrote ${writes.length} records`);
  process.exit(0);
}

main();
