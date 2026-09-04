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
    // Drives the stale sweep: who has not been looked at lately, cheapest first. Sparse,
    // because a person never enriched has no value here and is found by its absence.
    { key: { orgId: 1, productId: 1, lastEnrichedAt: 1 }, name: "enrichment_age" },
  ]);

  await db.collection(C.goalInstances).createIndexes([
    // Drives the tick: only goals actually due are read, so a daily goal costs nothing
    // on the ticks it is not due for.
    { key: { orgId: 1, status: 1, nextTickAt: 1 }, name: "due_ticks" },
    { key: { orgId: 1, personId: 1, status: 1 }, name: "active_goal_per_person" },
    // Drives verification: only campaigns actually due are read, so a person on a daily
    // tier costs nothing on the ticks in between.
    { key: { orgId: 1, productId: 1, status: 1, nextVerifyAt: 1 }, name: "due_verification" },
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
    // Rolls up what worked. Only sends that could report anything belong in a rate, so
    // the tracking flag is part of the key rather than a filter applied afterwards.
    { key: { orgId: 1, productId: 1, "variant.segment": 1, angle: 1, "tracking.clicks": 1 }, name: "outcome_rollup" },
    // What one person has already been shown. Read on every lead_card and before every
    // plan, so it must not be a scan of the whole product's history.
    { key: { orgId: 1, productId: 1, personId: 1, angle: 1 }, name: "angles_tried" },
  ]);

  // One document per {channel, step, hour}. Unique because two rows for the same bucket
  // would split a count that only means anything whole.
  await db.collection(C.outcomePriors).createIndex(
    { channel: 1, stepIndex: 1, hourLocal: 1 },
    { name: "prior_key", unique: true },
  );

  await db.collection(C.templates).createIndex(
    { orgId: 1, productId: 1, channel: 1, stage: 1, scope: 1, segmentKey: 1 },
    { name: "cascade_resolution" },
  );

  // One kit per product: the send path reads it by this key on every run.
  await db.collection(C.brandKits).createIndex(
    { orgId: 1, productId: 1 },
    { name: "brand_kit_identity", unique: true },
  );
  await db.collection(C.brandSources).createIndex(
    { enabled: 1, nextFetchAt: 1 },
    { name: "brand_due" },
  );
  await db.collection(C.brandSources).createIndex(
    { orgId: 1, productId: 1, precedence: 1 },
    { name: "brand_merge_order" },
  );

  await db.collection(C.routines).createIndex(
    { orgId: 1, productId: 1, key: 1 },
    { name: "routine_identity", unique: true },
  );

  await db.collection(C.routineRuns).createIndexes([
    { key: { orgId: 1, productId: 1, startedAt: -1 }, name: "run_log" },
    // Resolving which open run a tool call belongs to, on every single call.
    { key: { orgId: 1, userId: 1, status: 1, lastCallAt: -1 }, name: "open_run" },
    { key: { status: 1, lastCallAt: 1 }, name: "idle_runs" },
    // Counters are read daily and stay a month; the raw calls below are read twice a year
    // and would be the bulk of the collection, so they go sooner.
    { key: { startedAt: 1 }, name: "run_retention", expireAfterSeconds: 30 * 86_400 },
  ]);

  await db.collection(C.routineCalls).createIndexes([
    { key: { orgId: 1, runId: 1, ts: 1 }, name: "run_detail" },
    { key: { ts: 1 }, name: "call_retention", expireAfterSeconds: 14 * 86_400 },
  ]);

  await db.collection(C.events).createIndexes([
    { key: { orgId: 1, personId: 1, ts: -1 }, name: "person_timeline" },
    // The timeline is the one collection that grows with every touch on every person, and
    // nothing reads past the last couple of hundred entries. A year is well beyond the
    // window any caller asks for.
    { key: { ts: 1 }, name: "event_retention", expireAfterSeconds: 365 * 86_400 },
  ]);

  // Audit answers "who changed this, and when" long after the fact, so it outlives the rest.
  await db.collection(C.audit).createIndexes([
    { key: { orgId: 1, at: -1 }, name: "audit_log" },
    { key: { at: 1 }, name: "audit_retention", expireAfterSeconds: 180 * 86_400 },
  ]);

  // TTL skips documents whose indexed field is not a date, and readAt is null until someone
  // reads the notification. So this expires read notices a month on and leaves unread ones
  // standing, which is the behaviour wanted either way.
  await db.collection(C.notifications).createIndexes([
    { key: { orgId: 1, productId: 1, readAt: 1, updatedAt: -1 }, name: "inbox" },
    { key: { readAt: 1 }, name: "notification_retention", expireAfterSeconds: 30 * 86_400 },
  ]);

  // The lease. Without it two concurrent runs claim the same job and double-send.
  await db.collection(C.workQueue).createIndexes([
    { key: { orgId: 1, status: 1, dueAt: 1, leaseUntil: 1 }, name: "claimable" },
    // What a worker actually asks for: this kind, ready, urgent first, oldest first.
    { key: { orgId: 1, kind: 1, status: 1, priority: 1, dueAt: 1 }, name: "claimable_by_kind" },
    // Drives the dispatcher's grouped count. It runs every minute over the whole queue, so
    // it is the one query in the system that must never become a collection scan.
    { key: { orgId: 1, kind: 1, status: 1, productId: 1, campaignKey: 1 }, name: "dispatch_buckets" },
    // Deduplication on enqueue: one pending item per subject per kind, checked on every
    // detection pass, which is every minute for every person in flight.
    { key: { orgId: 1, kind: 1, subjectId: 1, status: 1 }, name: "one_per_subject" },
    // Lease reaping sweeps the whole collection for abandoned work regardless of tenant.
    { key: { status: 1, leaseUntil: 1 }, name: "expired_leases" },
  ]);

  // One playbook per segment per campaign. The uniqueness is the point: two playbooks for
  // the same segment means half a campaign silently runs a sequence nobody chose.
  await db.collection(C.playbooks).createIndex(
    { orgId: 1, productId: 1, goalKey: 1, segmentKey: 1 },
    { name: "playbook_per_segment", unique: true },
  );

  await db.collection(C.suppressions).createIndex(
    { orgId: 1, identityValue: 1 },
    { name: "suppression_lookup", unique: true },
  );

  await db.collection(C.users).createIndex({ email: 1 }, { name: "user_email", unique: true });
  await db.collection(C.memberships).createIndex({ userId: 1, orgId: 1 }, { name: "membership", unique: true });

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
