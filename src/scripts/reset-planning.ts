import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Puts a product back to "leads have arrived, nothing has been decided yet", so the Plan
 * and Compose routines can be run against the same people again.
 *
 * People and campaigns survive. What goes is everything the routines produced: the
 * classifications, the pipelines, the queued copy and the run log. Sent messages are kept
 * by default, because deleting them would lose the record that a real person was emailed.
 *
 *   npx tsx --env-file=.env src/scripts/reset-planning.ts <productId> [--sent]
 */
const productId = process.argv[2];
const alsoSent = process.argv.includes("--sent");

if (!productId) {
  console.error("usage: reset-planning.ts <productId> [--sent]");
  process.exit(1);
}

const db = await getDb();
const scope = { productId };

const people = await db.collection(C.people).countDocuments(scope);
const instances = await db.collection(C.goalInstances).countDocuments(scope);
console.log(`product ${productId}: ${people} people, ${instances} campaign instances\n`);

// Plans written before productId was stored on them can only be found through their goal
// instance, so both routes are used rather than trusting the newer field alone.
const instanceIds = (
  await db.collection(C.goalInstances).find(scope, { projection: { _id: 1 } }).toArray()
).map((i) => String(i._id));
const plans = await db
  .collection(C.plans)
  .deleteMany({ $or: [scope, { goalInstanceId: { $in: instanceIds } }] });
console.log("plans deleted           ", plans.deletedCount);

const cleared = await db
  .collection(C.goalInstances)
  .updateMany(scope, { $unset: { currentPlanId: "", lastReviewNote: "", lastReviewedAt: "" } });
console.log("instances unplanned     ", cleared.modifiedCount);

const reclassify = await db
  .collection(C.people)
  .updateMany(scope, { $set: { needsClassification: true }, $unset: { belief: "", temp: "" } });
console.log("people to reclassify    ", reclassify.modifiedCount);

const actionFilter = alsoSent ? scope : { ...scope, status: { $nin: ["sent", "dispatched"] } };
const actions = await db.collection(C.actions).deleteMany(actionFilter);
console.log(`actions deleted${alsoSent ? " (incl. sent)" : "         "}`, actions.deletedCount);

const runs = await db.collection(C.routineRuns).find(scope, { projection: { _id: 1 } }).toArray();
await db.collection(C.routineCalls).deleteMany({ runId: { $in: runs.map((r) => r._id) } });
await db.collection(C.routineRuns).deleteMany(scope);
console.log("runs deleted            ", runs.length);

console.log("\nCampaigns, checks and people are intact. Run Plan, then Compose.");
process.exit(0);
