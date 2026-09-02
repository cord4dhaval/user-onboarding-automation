import { MongoClient, type Db } from "mongodb";

/**
 * The client is cached on globalThis rather than in a module-level binding alone.
 *
 * A module binding is per module instance, and Next.js dev replaces the module instance on
 * every hot reload. The old instance's client is never closed, so an hour of editing leaves
 * a dozen pools open against the cluster — enough, on a 500-connection M0, to matter. The
 * globalThis handle outlives the reload and hands the same client back.
 */
const cache = globalThis as typeof globalThis & {
  __mongoClient?: MongoClient;
  __mongoDb?: Db;
};

/**
 * Cached across invocations so serverless entry points reuse one pool rather than opening
 * a connection per request.
 *
 * A failed connect discards the cached client. Keeping it would poison every later call:
 * the process would go on failing long after the underlying problem — a network rule, a
 * paused cluster — had been fixed.
 */
export async function getDb(): Promise<Db> {
  if (cache.__mongoDb) return cache.__mongoDb;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  // The pool is per replica-set member, so maxPoolSize is a per-node figure: a client can
  // hold three times this plus its monitoring sockets. Every warm serverless instance keeps
  // its own pool, so the ceiling that matters is instances × pool, counted against the
  // cluster's connection limit — 500 on M0. Three is well above what a tick needs.
  //
  // maxIdleTimeMS is what actually returns connections. The driver's default of 0 keeps an
  // idle socket open forever, which is why a near-silent cluster can still sit at a hundred
  // connections.
  //
  // Without ignoreUndefined the driver stores an optional field left blank as null. That
  // null then travels: a channel saved with no reply-to address sent replyTo: null to a
  // provider whose schema accepts a string or nothing, and every send on it failed.
  const candidate =
    cache.__mongoClient ??
    new MongoClient(uri, {
      maxPoolSize: 3,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      ignoreUndefined: true,
    });
  try {
    await candidate.connect();
  } catch (err) {
    cache.__mongoClient = undefined;
    cache.__mongoDb = undefined;
    await candidate.close().catch(() => undefined);
    throw err;
  }

  cache.__mongoClient = candidate;
  cache.__mongoDb = candidate.db(process.env.MONGODB_DB ?? "conversion_engine");
  return cache.__mongoDb;
}
