import { getDb } from "./client.js";
import { COLLECTIONS as C } from "./collections.js";

/**
 * Every index is compound on orgId. There are no exceptions to that rule — the first
 * exception is the query that leaks one tenant's leads into another tenant's dashboard.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  await db.collection(C.people).createIndexes([
    { key: { orgId: 1, productId: 1, "identities.value": 1 }, name: "identity_lookup" },
    { key: { orgId: 1, productId: 1, needsClassification: 1 }, name: "classification_backlog" },
    { key: { orgId: 1, companyDomain: 1 }, name: "by_company" },
  ]);

  await db.collection(C.goalInstances).createIndexes([
    // Drives the tick: only goals actually due are read, so a daily goal costs nothing
    // on the ticks it is not due for.
    { key: { orgId: 1, status: 1, nextTickAt: 1 }, name: "due_ticks" },
    { key: { orgId: 1, personId: 1, status: 1 }, name: "active_goal_per_person" },
  ]);

  await db.collection(C.sources).createIndex(
    { orgId: 1, enabled: 1, nextFetchAt: 1 },
    { name: "due_fetches" },
  );

  await db.collection(C.actions).createIndexes([
    { key: { orgId: 1, status: 1, dueAt: 1 }, name: "due_sends" },
    { key: { orgId: 1, goalInstanceId: 1, dueAt: 1 }, name: "touch_history" },
    // Enforces at the storage layer what the application must never get wrong.
    { key: { idempotencyKey: 1 }, name: "idempotency", unique: true },
    // Rate limiting counts real sends in a rolling window rather than trusting a counter.
    { key: { orgId: 1, channelId: 1, sentAt: -1 }, name: "rate_window" },
    { key: { orgId: 1, productId: 1, status: 1, providerMessageId: 1 }, name: "reconcile_queue" },
  ]);

  await db.collection(C.templates).createIndex(
    { orgId: 1, productId: 1, channel: 1, stage: 1, scope: 1, segmentKey: 1 },
    { name: "cascade_resolution" },
  );

  await db.collection(C.events).createIndex(
    { orgId: 1, personId: 1, ts: -1 },
    { name: "person_timeline" },
  );

  // The lease. Without it two concurrent runs claim the same job and double-send.
  await db.collection(C.workQueue).createIndex(
    { orgId: 1, status: 1, dueAt: 1, leaseUntil: 1 },
    { name: "claimable" },
  );

  await db.collection(C.suppressions).createIndex(
    { orgId: 1, identityValue: 1 },
    { name: "suppression_lookup", unique: true },
  );

  await db.collection(C.credentials).createIndex(
    { orgId: 1, connectionId: 1 },
    { name: "credential_lookup" },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureIndexes();
  console.log("indexes ensured");
  process.exit(0);
}
