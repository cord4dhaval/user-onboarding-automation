import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { McpClient } from "../mcp/client.js";
import { resolveSecret } from "../crypto/broker.js";

/**
 * Cuts a product's people down to one month's intake, and takes their history with them.
 *
 * A campaign that has been fed three months of leads and only wants the newest month is
 * carrying two months of people it will never write to again: they sit in the audience, in
 * the review queue, and in every count the product reports about itself. Suppressing them
 * would stop the sending and leave all of that in place, so this deletes.
 *
 * Deletion is the instruction and deletion is what this does — but the addresses are
 * written to the suppression list on the way out. Nothing else stops the poller finding the
 * same lead in the source next week and mailing a person who was deliberately removed;
 * suppression is keyed on the address rather than the person, so it survives the person
 * being gone. Pass --no-suppress to skip that, which is only right when the same people are
 * expected back through the front door.
 *
 * The kept month is decided from the source of truth, not from our own createdAt: a lead
 * ingested late still belongs to the month they actually submitted in.
 *
 * Everything removed is written to a JSON file first. The instruction is to delete and it
 * deletes, but a dump costs a second and is the difference between a decision that can be
 * revisited and one that cannot — and the question "who did we drop" is asked about this
 * kind of cut more often than anyone expects at the time.
 *
 *   npm run prune:leads -- --month 2026-09              what it would remove
 *   npm run prune:leads -- --month 2026-09 --yes        remove it
 *   npm run prune:leads -- --month 2026-09 --yes --out /tmp/cut.json
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MONTH = arg("month");
const EXECUTE = process.argv.includes("--yes");
const SUPPRESS = !process.argv.includes("--no-suppress");

const PRODUCT = arg("product") ?? "6a964454c4fa12977b6d6964";
const LEADS_CONNECTION = arg("connection") ?? "6a95705ca2577a246fdab936";
const BRAND = arg("brand") ?? "fe4479cc-ee44-4f4f-865f-8e4ca211f963";

interface Lead {
  submittedAt?: string;
  fields?: Record<string, string>;
}

/** The tool answers as text with a JSON body inside it. */
function parse(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
}

function emailOf(lead: Lead): string {
  const fields = lead.fields ?? {};
  const key =
    Object.keys(fields).find((k) => k.toLowerCase() === "email") ??
    Object.keys(fields).find((k) => k.toLowerCase().includes("email"));
  return key ? String(fields[key]).trim().toLowerCase() : "";
}

async function main(): Promise<void> {
  if (!MONTH || !/^\d{4}-\d{2}$/.test(MONTH)) {
    console.error("usage: npm run prune:leads -- --month YYYY-MM [--yes] [--no-suppress]");
    process.exit(1);
  }
  const db = await getDb();

  const connection = await db
    .collection(C.connections)
    .findOne({ _id: new ObjectId(LEADS_CONNECTION) });
  if (!connection) {
    console.error(`no connection ${LEADS_CONNECTION}`);
    process.exit(1);
  }
  const orgId = String(connection.orgId);
  const client = new McpClient(
    String(connection.serverUrl),
    await resolveSecret(orgId, LEADS_CONNECTION, orgId),
  );

  // Every lead the source will still show us. 2160 hours is its ceiling, and it answers
  // newest-first, so the month being kept is complete whenever it is a recent one — which
  // is the only kind worth keeping.
  const keepEmails = new Set<string>();
  let seen = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const args: Record<string, unknown> = { brandId: BRAND, limit: 100, sinceHours: 2160 };
    if (cursor) args.cursor = cursor;
    const body = parse(await client.callTool("list_leads", args));
    const batch = (body.leads ?? []) as Lead[];
    seen += batch.length;
    for (const lead of batch) {
      if (String(lead.submittedAt ?? "").slice(0, 7) !== MONTH) continue;
      const email = emailOf(lead);
      if (email) keepEmails.add(email);
    }
    cursor = (body.nextCursor ?? undefined) as string | undefined;
    if (!cursor || batch.length === 0) break;
  }
  console.log(`source: ${seen} leads in the window, ${keepEmails.size} of them in ${MONTH}`);

  const people = await db
    .collection(C.people)
    .find({ productId: PRODUCT })
    .project({ primaryEmail: 1, identities: 1, lastReplyAt: 1 })
    .toArray();

  const doomed = people.filter(
    (p) => !keepEmails.has(String(p.primaryEmail ?? "").trim().toLowerCase()),
  );
  const kept = people.length - doomed.length;
  const ids = doomed.map((p) => String(p._id));
  const emails = doomed
    .map((p) => String(p.primaryEmail ?? "").trim().toLowerCase())
    .filter(Boolean);

  if (ids.length === 0) {
    console.log("nothing to remove");
    process.exit(0);
  }

  // Their goal instances name the plans and the queued work, neither of which carries a
  // personId of its own. Collected before anything is deleted, because afterwards there is
  // no way back from a plan to the person it was written for.
  const instanceIds = (
    await db
      .collection(C.goalInstances)
      .find({ personId: { $in: ids } })
      .project({ _id: 1 })
      .toArray()
  ).map((g) => String(g._id));

  const counts = {
    people: ids.length,
    actions: await db.collection(C.actions).countDocuments({ personId: { $in: ids } }),
    goalInstances: instanceIds.length,
    plans: await db.collection(C.plans).countDocuments({ goalInstanceId: { $in: instanceIds } }),
    events: await db.collection(C.events).countDocuments({ personId: { $in: ids } }),
    workQueue: await db.collection(C.workQueue).countDocuments({ subjectId: { $in: instanceIds } }),
    notifications: await db
      .collection(C.notifications)
      .countDocuments({ dedupeKey: { $in: ids.flatMap((id) => [`engagement:clicked:${id}`, `engagement:opened:${id}`]) } }),
  };

  // What is actually being thrown away, said out loud. "208 people" and "208 people, 291 of
  // them already written to" are different decisions.
  const sent = await db
    .collection(C.actions)
    .countDocuments({ personId: { $in: ids }, status: { $in: ["sent", "dispatched"] } });
  const replied = doomed.filter((p) => p.lastReplyAt).length;

  console.log(`\nkeeping ${kept} people from ${MONTH}`);
  console.log(`removing ${ids.length} people, including ${sent} messages already sent to them`);
  if (replied > 0)
    console.log(`  ${replied} of them have REPLIED to you — deleting loses that conversation`);
  for (const [what, n] of Object.entries(counts)) console.log(`  ${what.padEnd(16)} ${n}`);
  console.log(
    SUPPRESS
      ? `\n${emails.length} addresses go on the suppression list so the poller cannot re-add them`
      : "\nsuppression skipped — the poller may re-ingest these people from the source",
  );

  if (!EXECUTE) {
    console.log("\nnothing was written. Re-run with --yes to remove them.");
    process.exit(0);
  }

  // The dump, before a single delete. Written whole rather than streamed: this is hundreds
  // of documents, not millions, and a file that either exists complete or not at all is
  // easier to trust than one that might have stopped halfway.
  const out =
    arg("out") ??
    `backups/pruned-${PRODUCT}-${MONTH}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        prunedAt: new Date().toISOString(),
        productId: PRODUCT,
        keptMonth: MONTH,
        people: await db.collection(C.people).find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }).toArray(),
        actions: await db.collection(C.actions).find({ personId: { $in: ids } }).toArray(),
        goalInstances: await db.collection(C.goalInstances).find({ personId: { $in: ids } }).toArray(),
        plans: await db.collection(C.plans).find({ goalInstanceId: { $in: instanceIds } }).toArray(),
        events: await db.collection(C.events).find({ personId: { $in: ids } }).toArray(),
      },
      null,
      2,
    ),
  );
  console.log(`\nbacked up to ${out}`);

  // Suppression first. If anything below fails partway, the addresses are already blocked
  // and a half-finished prune cannot start mailing them again.
  if (SUPPRESS && emails.length > 0) {
    await db.collection(C.suppressions).bulkWrite(
      emails.map((identityValue) => ({
        updateOne: {
          filter: { orgId, identityValue },
          update: {
            $setOnInsert: {
              orgId,
              identityValue,
              reason: `pruned: intake outside ${MONTH}`,
              at: new Date(),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  // Leaves first, roots last. A crash midway then leaves an orphaned person rather than an
  // action pointing at a person who no longer exists — the first is visible on a page, the
  // second breaks one.
  const objectIds = ids.map((id) => new ObjectId(id));
  const instanceObjectIds = instanceIds.map((id) => new ObjectId(id));
  await db.collection(C.workQueue).deleteMany({ subjectId: { $in: instanceIds } });
  await db.collection(C.plans).deleteMany({ goalInstanceId: { $in: instanceIds } });
  await db.collection(C.notifications).deleteMany({
    dedupeKey: { $in: ids.flatMap((id) => [`engagement:clicked:${id}`, `engagement:opened:${id}`]) },
  });
  await db.collection(C.events).deleteMany({ personId: { $in: ids } });
  await db.collection(C.actions).deleteMany({ personId: { $in: ids } });
  await db.collection(C.goalInstances).deleteMany({ _id: { $in: instanceObjectIds } });
  await db.collection(C.people).deleteMany({ _id: { $in: objectIds } });

  console.log("\nremoved.");
  console.log(`people left in this product: ${await db.collection(C.people).countDocuments({ productId: PRODUCT })}`);
  console.log(`actions left:                ${await db.collection(C.actions).countDocuments({ productId: PRODUCT })}`);
  console.log(`awaiting approval:           ${await db.collection(C.actions).countDocuments({ productId: PRODUCT, status: "awaiting_approval" })}`);
  process.exit(0);
}

void main();
