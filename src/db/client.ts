import { MongoClient, type Db } from "mongodb";

let client: MongoClient | undefined;
let db: Db | undefined;

/**
 * Cached across invocations. Serverless entry points reuse one pool rather than opening
 * a connection per request, which Atlas will otherwise exhaust under cron load.
 */
export async function getDb(): Promise<Db> {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  client ??= new MongoClient(uri, { maxPoolSize: 10 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB ?? "conversion_engine");
  return db;
}
