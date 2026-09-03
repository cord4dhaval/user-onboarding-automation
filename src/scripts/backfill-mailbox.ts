import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { isFreeProvider, mailboxFields } from "../engine/mailbox.js";

/**
 * Backfills emailKind on people ingested before the free-provider check existed.
 *
 * Those records were given the mail host as their employer — "gmail.com" as a company —
 * and every classification made from one was reasoning about the wrong organisation. The
 * field is only cleared where it plainly came from the address: a company the source
 * actually declared is knowledge this script does not have, and must survive.
 *
 * Run with --apply. Without it, nothing is written and the counts are printed.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const people = await db
    .collection(C.people)
    .find({}, { projection: { primaryEmail: 1, companyDomain: 1, emailKind: 1 } })
    .toArray();

  let kindSet = 0;
  let domainCleared = 0;
  let declaredKept = 0;
  const writes = [];

  for (const p of people) {
    const email = String(p.primaryEmail ?? "");
    if (!email) continue;

    const { emailKind } = mailboxFields(email);
    const current = String(p.companyDomain ?? "");
    const set: Record<string, unknown> = {};
    const unset: Record<string, string> = {};

    if (p.emailKind !== emailKind) {
      set.emailKind = emailKind;
      kindSet++;
    }
    // Only a domain that is itself a free mail host was inferred from the address. A
    // declared one — "brightpixel.studio" against a Gmail address — is real and stays.
    if (current && isFreeProvider(current)) {
      unset.companyDomain = "";
      domainCleared++;
    } else if (current && emailKind === "personal") {
      declaredKept++;
    }

    if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) continue;
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;
    writes.push({ updateOne: { filter: { _id: p._id }, update } });
  }

  console.log(`people scanned      ${people.length}`);
  console.log(`emailKind to set    ${kindSet}`);
  console.log(`companyDomain clear ${domainCleared}  (was a mail host, not an employer)`);
  console.log(`declared kept       ${declaredKept}  (personal address, real company named by the source)`);

  if (writes.length === 0) {
    console.log("\nnothing to do — every address is already classified.");
    process.exit(0);
  }
  if (!apply) {
    console.log("\nnothing written. re-run with:  npm run backfill:mailbox -- --apply");
    console.log("(the bare -- matters; without it npm keeps the flag for itself)");
    process.exit(0);
  }

  if (writes.length > 0) await db.collection(C.people).bulkWrite(writes, { ordered: false });
  console.log(`\napplied to ${writes.length} people`);
  process.exit(0);
}

main();
