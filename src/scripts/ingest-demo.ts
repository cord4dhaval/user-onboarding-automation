import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { runSource } from "../engine/runSource.js";

/**
 * Checkpoint 1: five leads arrive from a file-style source, get deduped and filtered,
 * open goal instances, and have their welcome touch queued on the right channel.
 * No MCP connection required — the same ingest path a webhook or poll would use.
 */

const ORG = "000000000000000000000001";
const PRODUCT = "000000000000000000000002";
const CHANNEL = new ObjectId("000000000000000000000010");
const SOURCE = new ObjectId("000000000000000000000020");

const LEADS = [
  { Email: "priya@cloudnine.dev", Name: "Priya Nair", Title: "VP Engineering", TZ: "Asia/Kolkata" },
  { Email: "rahul@brightpixel.in", Name: "Rahul Mehta", Title: "Founder", TZ: "Asia/Kolkata" },
  { Email: "sam@driftlabs.io", Name: "Sam Okoye", Title: "CEO", TZ: "Europe/London" },
  { Email: "deepa@northbpo.com", Name: "Deepa Shah", Title: "Head of HR", TZ: "Asia/Kolkata" },
  { Email: "priya@cloudnine.dev", Name: "Priya Nair", Title: "VP Engineering", TZ: "Asia/Kolkata" }, // duplicate
];

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function main() {
  const db = await getDb();

  console.log("\n── seed a channel and a source ──");

  // A stand-in email channel. Real channels arrive with a connection and credential;
  // this one exists so the first-touch picker has something healthy to choose.
  await db.collection(C.channels).updateOne(
    { _id: CHANNEL },
    {
      $set: {
        orgId: ORG,
        productId: PRODUCT,
        connectionId: "000000000000000000000011",
        key: "email",
        kind: "mcp",
        capabilities: { send: true, html: true, consentRequired: false, trackingOpens: false },
        governor: { dailyCap: 50, warmupDay: 1, sentToday: 0, windowStartedAt: new Date() },
        policy: { audience: ["cold", "warm_lead", "existing_user"] },
        status: "healthy",
        enabled: true,
      },
    },
    { upsert: true },
  );
  line("channel", "email (healthy, cap 50/day)");

  await db.collection(C.sources).updateOne(
    { _id: SOURCE },
    {
      $set: {
        orgId: ORG,
        productId: PRODUCT,
        connectionId: "000000000000000000000011",
        name: "Lead export",
        kind: "excel_upload",
        triggerMode: "batch",
        desiredIntervalSec: 600,
        effectiveIntervalSec: 600,
        // Claude generates this once per file from the actual column names.
        fieldMap: { email: "Email", name: "Name", role: "Title", timezone: "TZ" },
        dedupeKey: "email",
        defaultGoalKey: "new_user",
        enabled: true,
      },
    },
    { upsert: true },
  );
  line("source", "Lead export (batch, dedupe on email)");

  console.log("\n── run ingest ──");
  const summary = await runSource(String(SOURCE), LEADS);
  line("fetched", String(summary.fetched));
  line("people created", String(summary.created));
  line("attached to existing", String(summary.attachedToExisting));
  line("suppressed", String(summary.suppressed));
  line("filtered out", String(summary.filteredOut));
  line("first touches queued", String(summary.firstTouchesQueued));
  if (summary.errors.length) line("errors", summary.errors.join("; "));

  console.log("\n── queued welcome touches ──");
  const queued = await db
    .collection(C.actions)
    .find({ orgId: ORG, productId: PRODUCT, status: "queued" })
    .toArray();
  for (const action of queued) {
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
    const due = (action.dueAt as Date).toISOString().replace("T", " ").slice(0, 16);
    line(String(person?.name ?? "unknown"), `${action.channel} · due ${due} UTC`);
  }

  console.log("\n── goal instances ──");
  const goals = await db.collection(C.goalInstances).find({ orgId: ORG, status: "active" }).toArray();
  line("active", String(goals.length));
  if (goals[0]) {
    const g = goals[0];
    line("budget", `${g.spent.touches}/9 touches, deadline ${(g.deadline as Date).toISOString().slice(0, 10)}`);
  }

  console.log("\n── re-run (idempotency check) ──");
  const again = await runSource(String(SOURCE), LEADS);
  line("people created", String(again.created));
  line("first touches queued", String(again.firstTouchesQueued));
  console.log("  (both should be 0 — nothing duplicates on a repeated fetch)\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
