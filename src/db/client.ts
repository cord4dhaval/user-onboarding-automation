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

  const candidate = client ?? new MongoClient(uri, { maxPoolSize: 10 });
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
