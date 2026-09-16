import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { timezoneFor } from "../engine/time.js";

/**
 * Re-reads the timezone of people stored as "UTC" before it was inferred.
 *
 * Every spreadsheet and library import wrote "UTC" when the row had no timezone column,
 * which is nearly every row, so quiet hours were judged on UTC's night for leads in India,
 * Australia and New Zealand. Nothing ever set "UTC" on purpose, so each of those is replaced
 * by what the person's phone and address say. A queued message keeps the date it was given.
 *
 * Run with --apply. Without it, nothing is written and the counts are printed.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const people = await db
    .collection(C.people)
    .find({ timezone: "UTC" }, { projection: { primaryEmail: 1, identities: 1 } })
    .toArray();

  const byZone = new Map<string, number>();
  const writes = [];
  for (const p of people) {
    const identities = (p.identities ?? []) as { kind?: string; value?: string }[];
    const zone = timezoneFor({
      phone: identities.find((i) => i.kind === "phone")?.value,
      email: String(p.primaryEmail ?? ""),
    });
    byZone.set(zone, (byZone.get(zone) ?? 0) + 1);
    writes.push({ updateOne: { filter: { _id: p._id, timezone: "UTC" }, update: { $set: { timezone: zone } } } });
  }

  console.log(`people on "UTC"  ${people.length}`);
  for (const [zone, count] of [...byZone].sort((a, b) => b[1] - a[1])) console.log(`  ${zone.padEnd(22)} ${count}`);

  if (writes.length === 0) {
    console.log("\nnothing to do — nobody is on the old default.");
    process.exit(0);
  }
  if (!apply) {
    console.log("\nnothing written. re-run with:  npm run backfill:timezones -- --apply");
    console.log("(the bare -- matters; without it npm keeps the flag for itself)");
    process.exit(0);
  }

  await db.collection(C.people).bulkWrite(writes, { ordered: false });
  console.log(`\napplied to ${writes.length} people`);
  process.exit(0);
}

main();
