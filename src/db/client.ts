import { MongoClient, type Db } from "mongodb";

let client: MongoClient | undefined;
let db: Db | undefined;

/**
 * Cached across invocations so serverless entry points reuse one pool rather than opening
 * a connection per request.
 *
 * A failed connect discards the cached client. Keeping it would poison every later call:
 * the process would go on failing long after the underlying problem — a network rule, a
 * paused cluster — had been fixed.
 */
export async function getDb(): Promise<Db> {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  // Without ignoreUndefined the driver stores an optional field left blank as null. That
  // null then travels: a channel saved with no reply-to address sent replyTo: null to a
  // provider whose schema accepts a string or nothing, and every send on it failed.
  const candidate = client ?? new MongoClient(uri, { maxPoolSize: 10, ignoreUndefined: true });
  try {
    await candidate.connect();
  } catch (err) {
    client = undefined;
    db = undefined;
    await candidate.close().catch(() => undefined);
    throw err;
  }

  client = candidate;
  db = candidate.db(process.env.MONGODB_DB ?? "conversion_engine");
  return db;
}
