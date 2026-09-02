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

export type JobKind = "ingest_rows";

export interface Job<P = Record<string, unknown>> {
  _id: ObjectId;
  orgId: string;
  kind: JobKind;
  status: "queued" | "running" | "done" | "dead";
  payload: P;
  dueAt: Date;
  leaseUntil: Date;
  attempts: number;
  lastError?: string;
  createdAt: Date;
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
  dueAt = new Date(),
): Promise<string> {
  const db = await getDb();
  const _id = new ObjectId();
  await db.collection(C.workQueue).insertOne({
    _id,
    orgId,
    kind,
    status: "queued",
    payload,
    dueAt,
    leaseUntil: new Date(0),
    attempts: 0,
    createdAt: new Date(),
  });
  return String(_id);
}

/**
 * Takes one job and holds it for LEASE_MS. Running jobs are candidates too — an expired
 * lease means the worker holding it is gone, and the job has to move.
 *
 * The attempt is counted here rather than on failure, because the failures that matter
 * most are the ones that kill the worker before it can report anything.
 */
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
      status: { $in: ["queued", "running"] },
      dueAt: { $lte: now },
      leaseUntil: { $lt: now },
    },
    {
      $set: { status: "running", leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { sort: { dueAt: 1 }, returnDocument: "after" },
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
    .distinct("orgId", { kind, status: { $in: ["queued", "running"] }, dueAt: { $lte: now } })) as string[];
}
