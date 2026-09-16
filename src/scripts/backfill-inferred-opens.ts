import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Gives every clicked message the open its click proves.
 *
 * Clicks were recorded without an open whenever the pixel never fired — leads under
 * legitimate interest get no pixel, and many clients block images — so the library showed
 * "clicked" beside no "opened", which reads as impossible. The tracker now stamps the open
 * on a click; this does the same for clicks recorded before it did. The open is dated at the
 * click and flagged `openInferred`, so it can be told apart from one the pixel saw.
 *
 * Run with --apply. Without it, nothing is written and the count is printed.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const actions = await db
    .collection(C.actions)
    .find(
      { firstClickedAt: { $exists: true }, firstOpenedAt: { $exists: false } },
      { projection: { firstClickedAt: 1 } },
    )
    .toArray();

  console.log(`clicked but not opened  ${actions.length}`);
  if (actions.length === 0) {
    console.log("\nnothing to do.");
    process.exit(0);
  }
  if (!apply) {
    console.log("\nnothing written. re-run with:  npx tsx --env-file=.env src/scripts/backfill-inferred-opens.ts --apply");
    process.exit(0);
  }

  const writes = actions.map((a) => ({
    updateOne: {
      filter: { _id: a._id, firstOpenedAt: { $exists: false } },
      update: { $set: { firstOpenedAt: a.firstClickedAt, openInferred: true } },
    },
  }));
  await db.collection(C.actions).bulkWrite(writes, { ordered: false });
  console.log(`\napplied to ${writes.length} messages`);
  process.exit(0);
}

main();
