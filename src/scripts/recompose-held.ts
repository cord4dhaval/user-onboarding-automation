import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Sends held messages back to be written again.
 *
 * A message waiting for review is never re-claimed by a send run, and once approved its
 * stored copy ships exactly as read — which is the right rule, and the reason a fix to the
 * copy does not reach anything already queued. After changing a template, a merge field or
 * the way a name is worked out, this is what makes the waiting messages catch up.
 *
 * The subject is cleared along with the body. Re-rendering keeps a subject that is already
 * present, so leaving it would fix the greeting inside the mail and leave the old one in
 * the inbox line, which is the half-fix nobody notices until it has gone out.
 *
 * Only messages nobody has decided on. A rejected message stays rejected, and an approved
 * one keeps the words that were approved.
 *
 *   npm run recompose -- --goal=teamgrid_leads          (dry run)
 *   npm run recompose -- --goal=teamgrid_leads --apply
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const goalKey = arg("goal");
  const db = await getDb();

  const filter: Record<string, unknown> = { status: "awaiting_approval" };
  if (goalKey) {
    const instances = await db
      .collection(C.goalInstances)
      .find({ goalKey }, { projection: { _id: 1 } })
      .toArray();
    filter.goalInstanceId = { $in: instances.map((i) => String(i._id)) };
  }

  const held = await db
    .collection(C.actions)
    .find(filter, { projection: { "content.subject": 1, personId: 1 } })
    .toArray();

  console.log(`held messages ${goalKey ? `on ${goalKey}` : "across every campaign"}: ${held.length}`);
  for (const a of held.slice(0, 5)) {
    console.log(`  ${JSON.stringify((a.content as { subject?: string })?.subject ?? null)}`);
  }
  if (held.length > 5) console.log(`  … and ${held.length - 5} more`);

  if (held.length === 0) {
    console.log("\nnothing to do.");
    process.exit(0);
  }
  if (!apply) {
    console.log("\nnothing written. re-run with --apply");
    console.log("Deploy the copy change FIRST — otherwise they are rewritten by the same code.");
    process.exit(0);
  }

  const result = await db.collection(C.actions).updateMany(filter, {
    // Back to the queue, unreviewed, so the next send run claims them and writes them
    // again. The gate will hold them exactly as it did the first time.
    $set: { status: "queued" },
    $unset: {
      "content.subject": "",
      "content.preheader": "",
      "content.bodyMd": "",
      "content.bodyHtml": "",
      validation: "",
    },
  });

  console.log(`\nreturned ${result.modifiedCount} to the queue.`);
  console.log("They will be rewritten on the next tick and held for review again.");
  process.exit(0);
}

main();
