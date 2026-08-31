import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Checked before every ingest and before every send. Suppression is permanent and
 * global to the tenant — an unsubscribe from one goal silences every goal.
 */
export async function isSuppressed(orgId: string, values: string[]): Promise<boolean> {
  if (values.length === 0) return false;
  const db = await getDb();
  const hit = await db
    .collection(C.suppressions)
    .findOne({ orgId, identityValue: { $in: values } }, { projection: { _id: 1 } });
  return hit !== null;
}

export async function suppress(orgId: string, identityValue: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.collection(C.suppressions).updateOne(
    { orgId, identityValue },
    { $setOnInsert: { orgId, identityValue, reason, at: new Date() } },
    { upsert: true },
  );
}
