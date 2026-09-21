import { writeFileSync } from "node:fs";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { recomputeTemps } from "../engine/temp.js";

/**
 * Rewrites every stored temperature from campaign lead types, people in no running campaign
 * included (2026-09-21: the lead type became the only type, and the person's own score was
 * dropped). The tick reads people in flight the same way, a hundred at a time; this does all
 * of them at once. The old readings are saved to the file given first.
 *
 *   npx tsx --env-file=.env src/scripts/rewrite-temps.ts <backup.json>
 */
async function main() {
  const backup = process.argv[2];
  if (!backup) throw new Error("usage: rewrite-temps.ts <backup.json>");
  const db = await getDb();

  const before = await db.collection(C.people).find({}, { projection: { temp: 1 } }).toArray();
  writeFileSync(backup, JSON.stringify(before));
  console.log(`${before.length} readings saved to ${backup}`);

  const products = await db.collection(C.products).find({}, { projection: { orgId: 1, name: 1 } }).toArray();
  for (const product of products) {
    const orgId = String(product.orgId);
    const productId = String(product._id);
    const total = await db.collection(C.people).countDocuments({ orgId, productId });
    if (total === 0) continue;
    const summary = await recomputeTemps(orgId, productId, total, new Date(), { everyone: true });
    console.log(`${String(product.name)}: ${JSON.stringify(summary)}`);
  }
  process.exit(0);
}

void main();
