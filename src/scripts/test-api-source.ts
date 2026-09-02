import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { sealSecret } from "../crypto/envelope.js";
import { runSource } from "../engine/runSource.js";

/**
 * Wires a product up to /api/test/leads and pulls from it, so the recurring "API + token"
 * input can be exercised without a real CRM. The feed releases one demo lead every
 * `--every` seconds, so running this twice a few minutes apart is the only way to see
 * what actually matters: leads that did not exist at the last poll being picked up,
 * deduped against the ones that did, and turned into first touches.
 *
 *   npm run test:api -- --to=you@gmail.com                 # create the input, pull once
 *   npm run test:api -- --pull                             # pull again, nothing recreated
 *   npm run test:api -- --to=you@gmail.com --every=60 --interval=120 --reset
 *
 *   --to        base mailbox; every demo lead is plus-addressed off it (default DEMO_EMAIL)
 *   --product   product id or name (default: the only active product)
 *   --goal      goal key the leads enter (default: the product's first enabled goal)
 *   --base      origin the app is served on (default APP_URL, TICK_URL's origin, :3000)
 *   --every     seconds between one demo lead and the next (default 120)
 *   --max       how many demo leads the feed holds in total (default 20)
 *   --interval  how often the cron poll refetches this source (default 300)
 *   --pull      skip creation, just fetch now
 *   --reset     delete the demo people and this input first, then start clean
 */

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [key, value = "true"] = a.replace(/^--/, "").split("=");
    return [key!, value] as const;
  }),
);
const arg = (key: string, fallback?: string) => args.get(key) ?? fallback;
const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(22)} ${String(value)}`);

/** The name is fixed so re-running updates one input instead of leaving a trail of them. */
const SOURCE_NAME = "Test API leads";
const CONNECTION_KEY = "test_api_feed";

async function main() {
  const db = await getDb();

  const productArg = arg("product");
  const product = productArg
    ? await db.collection(C.products).findOne(
        ObjectId.isValid(productArg) ? { _id: new ObjectId(productArg) } : { name: productArg },
      )
    : await db.collection(C.products).findOne({ status: "active" });
  if (!product) throw new Error("No product found. Pass --product=<id or name>.");

  const orgId = String(product.orgId);
  const productId = String(product._id);

  const goalKey = arg("goal") ?? String(
    (await db.collection(C.goals).findOne({ orgId, productId, enabled: true }))?.key ?? "",
  );
  if (!goalKey) throw new Error("That product has no enabled goal. Create one first.");

  console.log("\n── target ──");
  line("product", `${String(product.name)} · ${productId}`);
  line("goal", goalKey);

  if (args.has("reset")) await reset(orgId, productId);

  const existing = await db.collection(C.sources).findOne({ orgId, productId, name: SOURCE_NAME });
  const source = existing && args.has("pull") ? existing : await upsertSource(orgId, productId, goalKey);

  console.log("\n── input ──");
  line("source", String(source._id));
  line("endpoint", String(source.endpointUrl ?? (await endpointOf(String(source.connectionId)))));
  line("poll every", `${Number(source.effectiveIntervalSec ?? 300)}s`);

  // The pull runs the same runSource the cron tick and the MCP tool both call, so a green
  // result here means those two paths are green as well.
  console.log("\n── pull ──");
  const summary = await runSource(String(source._id));
  for (const [key, value] of Object.entries(summary)) {
    line(key, Array.isArray(value) ? (value.length ? value.join("; ") : "none") : value);
  }

  const queued = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "queued" })
    .sort({ dueAt: 1 })
    .limit(5)
    .toArray();
  if (queued.length) {
    console.log("\n── first touches waiting to send ──");
    for (const action of queued) {
      const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
      line(String(person?.primaryEmail ?? action.personId), `due ${new Date(String(action.dueAt)).toISOString()}`);
    }
  }

  console.log(
    "\nRun it again in a few minutes to see the next leads arrive; hit /api/cron/tick to send what is queued.\n",
  );
  process.exit(0);
}

/** Creates the connection, its token and the source, or updates them if they already exist. */
async function upsertSource(orgId: string, productId: string, goalKey: string) {
  const db = await getDb();

  const base = (arg("base") ?? process.env.APP_URL ?? origin(process.env.TICK_URL) ?? "http://localhost:3000")
    .replace(/\/$/, "");
  const to = arg("to") ?? process.env.DEMO_EMAIL;
  if (!to?.includes("@")) throw new Error("Pass --to=you@example.com (or set DEMO_EMAIL).");

  const url = new URL(`${base}/api/test/leads`);
  url.searchParams.set("to", to);
  url.searchParams.set("every", arg("every", "120")!);
  url.searchParams.set("max", arg("max", "20")!);
  // Anchored now rather than left to default, so the drip starts when the test does and
  // the first pull sees one lead rather than a pile of them.
  url.searchParams.set("from", new Date().toISOString());

  const connection = await db.collection(C.connections).findOneAndUpdate(
    { orgId, productId, key: CONNECTION_KEY },
    {
      $set: { endpointUrl: url.toString(), status: "healthy", authType: "bearer", directions: ["in"] },
      $setOnInsert: {
        provider: "test feed",
        scopes: [],
        createdBy: orgId,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  const connectionId = String(connection!._id);

  // The feed only checks this when TEST_FEED_TOKEN is set, but it is stored and resolved
  // through the same broker a real token would be, so the credential path is tested too.
  await db.collection(C.credentials).updateOne(
    { orgId, connectionId },
    {
      $set: {
        authType: "bearer",
        ...sealSecret(process.env.TEST_FEED_TOKEN ?? "local-dev"),
        status: "verified",
      },
    },
    { upsert: true },
  );

  const interval = Number(arg("interval", "300"));
  const result = await db.collection(C.sources).findOneAndUpdate(
    { orgId, productId, name: SOURCE_NAME },
    {
      $set: {
        connectionId,
        kind: "api_pull",
        defaultGoalKey: goalKey,
        // Real time, so the first touch is not held back to a civil hour — a test that
        // queues everything for 9am tomorrow proves nothing today.
        triggerMode: "realtime",
        dedupeKey: "email",
        // The feed accepts `since`, so the source resumes from the last lead it saw
        // rather than re-reading the whole endpoint on every poll.
        cursorParam: "since",
        // Spelled out in full rather than left at the email/name default, so the demo
        // rows exercise timezone and company handling as well.
        fieldMap: {
          email: "email",
          name: "name",
          role: "role",
          company_domain: "company_domain",
          timezone: "timezone",
        },
        enabled: true,
        desiredIntervalSec: interval,
        effectiveIntervalSec: Math.max(interval, 60),
        nextFetchAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return result!;
}

/** Removes what a previous run left behind, so a rerun starts from an empty product. */
async function reset(orgId: string, productId: string) {
  const db = await getDb();
  const source = await db.collection(C.sources).findOne({ orgId, productId, name: SOURCE_NAME });
  if (!source) return;

  const sourceId = String(source._id);
  const people = await db.collection(C.people).find({ orgId, productId, sourceId }).toArray();
  const personIds = people.map((p) => String(p._id));

  await db.collection(C.actions).deleteMany({ orgId, productId, personId: { $in: personIds } });
  await db.collection(C.goalInstances).deleteMany({ orgId, productId, personId: { $in: personIds } });
  await db.collection(C.people).deleteMany({ _id: { $in: people.map((p) => p._id) } });
  await db.collection(C.sources).deleteOne({ _id: source._id });

  console.log(`\n── reset ── removed ${people.length} demo people and their queued touches`);
}

async function endpointOf(connectionId: string): Promise<string> {
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  return String(connection?.endpointUrl ?? "—");
}

function origin(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
