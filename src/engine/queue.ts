import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * The background queue. Anything that takes longer than a page load belongs here rather
 * than in the request that started it: a hundred-row spreadsheet ingested inline held the
 * form's submit button for three minutes, and would have hit the platform's request
 * timeout long before a ten-thousand-row one finished.
 *
 * Claiming is a lease, not a flag. The clock is hit every minute and a slow tick still
 * overlaps the next one, so two workers do reach for the same job; the atomic
 * findOneAndUpdate means only one of them gets it. A worker that dies mid-job leaves the
 * lease to expire and the job returns to the pool on its own — nothing has to notice the
 * crash.
 */

/**
 * Work the engine does itself, and work it can only queue for a session to do.
 *
 * `ingest_rows` is engine work: a chunk of spreadsheet the tick drains on its own budget.
 * The rest is judgment — who someone is, what to say to them, whether they are finished —
 * and is claimed by the hourly Claude routines. Both live in one collection because both
 * need the same three properties: a lease so two workers cannot take the same item, a
 * durable record so a killed worker loses nothing, and a tenant key so no product can
 * starve another.
 */
export const THINKING_KINDS = ["classify", "playbook", "compose", "escalate", "monitor", "groom"] as const;
export type ThinkingKind = (typeof THINKING_KINDS)[number];
export type JobKind = "ingest_rows" | ThinkingKind;

/**
 * Urgent work is not subject to fairness. A reply or a click is the thing the whole system
 * exists to catch, and making it wait behind a routine classification of somebody who has
 * done nothing is the one queue behaviour that cannot be defended.
 */
export const PRIORITY = { urgent: 0, normal: 1, background: 2 } as const;

export interface Job<P = Record<string, unknown>> {
  _id: ObjectId;
  orgId: string;
  kind: JobKind;
  /**
   * `queued` is waiting to be chosen; `ready` has been chosen by the dispatcher and is the
   * only state a thinking worker may claim from. The extra state is what lets fairness be
   * decided every minute by code while the workers that act on it run once an hour.
   */
  status: "queued" | "ready" | "running" | "done" | "dead";
  payload: P;
  dueAt: Date;
  leaseUntil: Date;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  productId?: string;
  campaignKey?: string;
  priority?: number;
  subjectId?: string;
}

export interface EnqueueOptions {
  dueAt?: Date;
  productId?: string;
  campaignKey?: string;
  priority?: number;
  /**
   * The person, goal instance or segment this item is about. Also the deduplication key:
   * one pending item per subject per kind, so a person who clicks four times in a minute
   * is escalated once rather than four times.
   */
  subjectId?: string;
}

/** Long enough for a chunk to finish, short enough that a crashed worker frees it fast. */
const LEASE_MS = 90_000;

/** A job that has failed this many times is not going to start working on the next try. */
const MAX_ATTEMPTS = 5;

/**
 * A queued job carries an already-expired lease rather than none at all, so the claim
 * filter is a single range check on every candidate. An $or over "missing or expired"
 * would read the same but could not use the index.
 */
export async function enqueue(
  orgId: string,
  kind: JobKind,
  payload: Record<string, unknown>,
  options: Date | EnqueueOptions = {},
): Promise<string> {
  const db = await getDb();
  const opts: EnqueueOptions = options instanceof Date ? { dueAt: options } : options;
  const _id = new ObjectId();

  // One pending item per subject per kind. The engine notices the same condition on every
  // tick — a person still unclassified, a buffer still low — and without this the queue
  // would grow by one row a minute for a person nobody has got to yet, and the dispatcher
  // would then spend a campaign's whole quantum on duplicates of one lead.
  if (opts.subjectId) {
    const existing = await db.collection(C.workQueue).findOne({
      orgId,
      kind,
      subjectId: opts.subjectId,
      status: { $in: ["queued", "ready", "running"] },
    });
    if (existing) {
      // A later request may be more urgent than the one already waiting — a person who was
      // queued for a routine look and has since replied. Urgency is raised, never lowered.
      const priority = opts.priority ?? PRIORITY.normal;
      if (priority < Number(existing.priority ?? PRIORITY.normal)) {
        await db
          .collection(C.workQueue)
          .updateOne({ _id: existing._id }, { $set: { priority, dueAt: opts.dueAt ?? new Date() } });
      }
      return String(existing._id);
    }
  }

  await db.collection(C.workQueue).insertOne({
    _id,
    orgId,
    kind,
    status: "queued",
    payload,
    dueAt: opts.dueAt ?? new Date(),
    leaseUntil: new Date(0),
    attempts: 0,
    createdAt: new Date(),
    productId: opts.productId,
    campaignKey: opts.campaignKey,
    priority: opts.priority ?? PRIORITY.normal,
    subjectId: opts.subjectId,
  });
  return String(_id);
}

/**
 * Many items of one kind, deduplicated and inserted in two queries rather than in three
 * per row.
 *
 * The per-row version was correct and unusably slow: a round trip to a hosted cluster is
 * about forty milliseconds, and the detection pass runs over every person in flight on
 * every tick. Five hundred rows at three round trips each is a minute of wall clock inside
 * a function the platform kills at sixty seconds — so the tick would send its mail, die
 * before it recorded anything, and look from the outside like a system that was working.
 */
export async function enqueueMany(
  orgId: string,
  kind: JobKind,
  items: Array<{ subjectId: string; payload: Record<string, unknown> } & Omit<EnqueueOptions, "subjectId">>,
  now = new Date(),
): Promise<number> {
  if (items.length === 0) return 0;
  const db = await getDb();

  const subjectIds = items.map((i) => i.subjectId);
  const pending = await db
    .collection(C.workQueue)
    .find(
      { orgId, kind, subjectId: { $in: subjectIds }, status: { $in: ["queued", "ready", "running"] } },
      { projection: { subjectId: 1, priority: 1 } },
    )
    .toArray();
  const already = new Map(pending.map((p) => [String(p.subjectId), Number(p.priority ?? PRIORITY.normal)]));

  const fresh = items.filter((i) => !already.has(i.subjectId));
  // An item already waiting may have become urgent since — somebody queued for a routine
  // look who has since replied. Urgency is raised, never lowered.
  const promote = items.filter(
    (i) => already.has(i.subjectId) && (i.priority ?? PRIORITY.normal) < already.get(i.subjectId)!,
  );

  if (promote.length) {
    await db.collection(C.workQueue).updateMany(
      { orgId, kind, subjectId: { $in: promote.map((p) => p.subjectId) }, status: { $in: ["queued", "ready"] } },
      { $set: { priority: PRIORITY.urgent, dueAt: now } },
    );
  }
  if (fresh.length === 0) return 0;

  await db.collection(C.workQueue).insertMany(
    fresh.map((item) => ({
      _id: new ObjectId(),
      orgId,
      kind,
      status: "queued",
      payload: item.payload,
      dueAt: item.dueAt ?? now,
      leaseUntil: new Date(0),
      attempts: 0,
      createdAt: now,
      productId: item.productId,
      campaignKey: item.campaignKey,
      priority: item.priority ?? PRIORITY.normal,
      subjectId: item.subjectId,
    })),
    { ordered: false },
  );
  return fresh.length;
}

/**
 * Takes one job and holds it for LEASE_MS. Running jobs are candidates too — an expired
 * lease means the worker holding it is gone, and the job has to move.
 *
 * The attempt is counted here rather than on failure, because the failures that matter
 * most are the ones that kill the worker before it can report anything.
 */
/**
 * Which states a kind may be claimed from.
 *
 * Engine work is claimed straight out of `queued`: the tick both queues and drains it, and
 * a dispatcher standing in between would only add a minute of latency to an import. Work a
 * session does is claimed only from `ready`, because that is the state the dispatcher owns
 * — it is where fairness across products and campaigns is actually applied.
 */
function claimableFrom(kind: JobKind): string[] {
  return kind === "ingest_rows" ? ["queued", "running"] : ["ready", "running"];
}

export async function claim<P = Record<string, unknown>>(
  orgId: string,
  kind: JobKind,
  now = new Date(),
): Promise<Job<P> | null> {
  const db = await getDb();
  const claimed = await db.collection(C.workQueue).findOneAndUpdate(
    {
      orgId,
      kind,
      status: { $in: claimableFrom(kind) },
      dueAt: { $lte: now },
      leaseUntil: { $lt: now },
    },
    {
      $set: { status: "running", leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    // Urgent first, then oldest. Sorting on dueAt alone let a routine item queued an hour
    // ago outrank a reply that arrived a minute ago, which is the wrong answer every time.
    { sort: { priority: 1, dueAt: 1 }, returnDocument: "after" },
  );
  if (!claimed) return null;

  // Counted on the way in, so a job that keeps taking the worker down with it is retired
  // here rather than being handed to a sixth worker.
  if ((claimed.attempts as number) > MAX_ATTEMPTS) {
    await db
      .collection(C.workQueue)
      .updateOne({ _id: claimed._id }, { $set: { status: "dead", leaseUntil: new Date(0) } });
    return null;
  }

  return claimed as unknown as Job<P>;
}

export async function complete(jobId: ObjectId | string): Promise<void> {
  const db = await getDb();
  await db
    .collection(C.workQueue)
    .updateOne(
      { _id: new ObjectId(String(jobId)) },
      { $set: { status: "done", leaseUntil: new Date(0), finishedAt: new Date() } },
    );
}

/**
 * Back to queued with the lease dropped, so the next tick picks it up. Retrying a
 * transient failure immediately would usually just fail again against the same outage;
 * the delay grows with the attempts already spent.
 */
export async function fail(jobId: ObjectId | string, error: string): Promise<void> {
  const db = await getDb();
  const _id = new ObjectId(String(jobId));
  const job = await db.collection(C.workQueue).findOne({ _id });
  const attempts = Number(job?.attempts ?? 1);

  await db.collection(C.workQueue).updateOne(
    { _id },
    {
      $set: {
        status: attempts >= MAX_ATTEMPTS ? "dead" : "queued",
        lastError: error.slice(0, 500),
        leaseUntil: new Date(0),
        dueAt: new Date(Date.now() + Math.min(attempts, 5) * 60_000),
      },
    },
  );
}

/** Every org with something waiting. Drives a worker that is not already inside a loop. */
export async function orgsWithWork(kind: JobKind, now = new Date()): Promise<string[]> {
  const db = await getDb();
  return (await db
    .collection(C.workQueue)
    .distinct("orgId", {
      kind,
      status: { $in: claimableFrom(kind) },
      dueAt: { $lte: now },
    })) as string[];
}

/**
 * A batch of ready work for one kind, leased together.
 *
 * A session is billed for its context, not its round trips, so it wants fifty people in
 * one claim rather than fifty claims. Leasing them as a group also makes the failure clean:
 * if the session dies, the whole batch returns at once when the lease expires, rather than
 * half of it being marked done and the other half silently retried.
 */
export async function claimBatch<P = Record<string, unknown>>(
  orgId: string,
  kind: ThinkingKind,
  limit: number,
  now = new Date(),
): Promise<Job<P>[]> {
  const db = await getDb();
  const candidates = await db
    .collection(C.workQueue)
    .find({
      orgId,
      kind,
      status: { $in: claimableFrom(kind) },
      dueAt: { $lte: now },
      leaseUntil: { $lt: now },
    })
    .sort({ priority: 1, dueAt: 1 })
    .limit(Math.max(1, limit))
    .toArray();

  const taken: Job<P>[] = [];
  for (const candidate of candidates) {
    // Claimed one at a time even though they were read as a batch: the read is not atomic
    // and another worker may have taken any of them in between. The filter repeats the
    // lease condition so only rows still genuinely free are taken.
    const claimed = await db.collection(C.workQueue).findOneAndUpdate(
      { _id: candidate._id, status: { $in: claimableFrom(kind) }, leaseUntil: { $lt: now } },
      {
        $set: { status: "running", leaseUntil: new Date(now.getTime() + LEASE_MS) },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    );
    if (claimed) taken.push(claimed as unknown as Job<P>);
  }
  return taken;
}

/**
 * Returns expired leases to the pool.
 *
 * A Claude session that is killed mid-batch — the platform reclaiming it, a timeout, a
 * crash — leaves rows marked running that nobody is working on. Nothing else in the system
 * would ever look at them again, so the work would be lost silently, which is the one
 * outcome the queue exists to prevent.
 */
export async function reapLeases(now = new Date()): Promise<{ requeued: number; dead: number }> {
  const db = await getDb();
  const expired = await db
    .collection(C.workQueue)
    .find({ status: "running", leaseUntil: { $lt: now } })
    .limit(500)
    .toArray();

  let requeued = 0;
  let dead = 0;
  for (const job of expired) {
    const attempts = Number(job.attempts ?? 0);
    const finished = attempts >= MAX_ATTEMPTS;
    await db.collection(C.workQueue).updateOne(
      { _id: job._id },
      {
        $set: {
          // Back to `ready` rather than `queued` for thinking work: the dispatcher already
          // judged this item worth doing, and sending it back for re-selection would let a
          // person who has been picked up and dropped fall behind people who never were.
          status: finished ? "dead" : job.kind === "ingest_rows" ? "queued" : "ready",
          leaseUntil: new Date(0),
          lastError: finished ? "lease expired too many times" : "lease expired; requeued",
        },
      },
    );
    if (finished) dead++;
    else requeued++;
  }
  return { requeued, dead };
}

/**
 * Hands leased work back untouched.
 *
 * A worker that claims a batch and then finds part of it is not its to do must return that
 * part immediately rather than let the lease run out: the lease is minutes long, and for
 * those minutes the work is invisible to everybody, including the worker that should have
 * had it.
 */
export async function releaseAll(jobIds: Array<ObjectId | string>): Promise<void> {
  if (jobIds.length === 0) return;
  const db = await getDb();
  await db.collection(C.workQueue).updateMany(
    { _id: { $in: jobIds.map((id) => new ObjectId(String(id))) }, status: "running" },
    // Back to ready, not queued: the dispatcher already judged this worth doing, and
    // sending it round for re-selection would put it behind work that was never chosen.
    { $set: { status: "ready", leaseUntil: new Date(0) }, $inc: { attempts: -1 } },
  );
}

/** Marks a whole leased batch done in one write. */
export async function completeAll(jobIds: Array<ObjectId | string>): Promise<void> {
  if (jobIds.length === 0) return;
  const db = await getDb();
  await db.collection(C.workQueue).updateMany(
    { _id: { $in: jobIds.map((id) => new ObjectId(String(id))) } },
    { $set: { status: "done", leaseUntil: new Date(0), finishedAt: new Date() } },
  );
}
