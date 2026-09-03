import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { stampGoalOutcome } from "../engine/outcomes.js";

/**
 * Attributes campaigns that already finished back to the messages that produced them.
 *
 * New resolutions stamp themselves. Everything decided before that code existed knows only
 * that it succeeded — the actions carry no verdict, so the first read of what_works would
 * show every angle at zero wins and read as though nothing had ever worked.
 *
 * Run with --apply. Without it, nothing is written.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const resolved = await db
    .collection(C.goalInstances)
    .find({ status: { $in: ["succeeded", "failed"] } }, { projection: { orgId: 1, status: 1 } })
    .toArray();

  // Counted rather than assumed: the run is idempotent, so "3 resolved campaigns" says
  // nothing about whether there is anything left to do. Reporting only that made a
  // finished backfill look identical to one that had never run.
  const pending = await db.collection(C.actions).countDocuments({
    goalInstanceId: { $in: resolved.map((i) => String(i._id)) },
    status: { $in: ["sent", "dispatched"] },
    goalOutcome: { $exists: false },
  });

  console.log(`resolved campaigns   ${resolved.length}`);
  console.log(`actions to stamp     ${pending}`);
  if (pending === 0) {
    console.log("\nnothing to do — every resolved campaign is already attributed.");
    process.exit(0);
  }
  if (!apply) {
    console.log("\nnothing written. re-run with:  npm run backfill:outcomes -- --apply");
    console.log("(the bare -- matters; without it npm keeps the flag for itself)");
    process.exit(0);
  }

  let stamped = 0;
  for (const instance of resolved) {
    stamped += await stampGoalOutcome(
      String(instance.orgId),
      String(instance._id),
      instance.status === "succeeded" ? "won" : "lost",
    );
  }
  console.log(`actions stamped     ${stamped}`);
  process.exit(0);
}

main();
