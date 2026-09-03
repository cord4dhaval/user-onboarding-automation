import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { runSource } from "../engine/runSource.js";

/**
 * Puts one message in front of a real inbox so every signal can be exercised by hand.
 *
 * Deliberately does not render or send. Rendering here would bake this machine's APP_URL
 * into the links, and a tracking link pointing at localhost proves nothing — so the message
 * is queued and pre-approved, and the deployed app writes and sends it on its next tick
 * with its own origin.
 *
 * Consent is set to opt_in for this one person, because the pixel is gated on it and the
 * point of the exercise is to see whether the pixel works.
 *
 *   npm run test:signals -- --to=you+track@gmail.com
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const line = (k: string, v: string) => console.log(`  ${k.padEnd(20)} ${v}`);

async function main(): Promise<void> {
  const to = arg("to");
  if (!to?.includes("@")) throw new Error("npm run test:signals -- --to=you+track@gmail.com");

  const db = await getDb();
  const source = await db.collection(C.sources).findOne({ kind: "excel_upload", enabled: true });
  if (!source) throw new Error("no upload source to ingest through");
  const orgId = String(source.orgId);
  const productId = String(source.productId);

  await runSource(String(source._id), [
    { Email: to, Name: "Signal Test", Title: "", Company: "", TZ: "Asia/Kolkata" },
  ] as never);

  const person = await db.collection(C.people).findOne({ orgId, productId, primaryEmail: to });
  if (!person) throw new Error("person was not created — already suppressed?");
  const personId = String(person._id);

  // The pixel needs opt_in. This is a test address the operator owns, and without it the
  // open half of the exercise cannot run at all.
  await db.collection(C.people).updateOne(
    { _id: new ObjectId(personId) },
    { $set: { "consent.state": "opt_in", "consent.evidence": "operator test address" } },
  );

  const action = await db
    .collection(C.actions)
    .findOne({ orgId, productId, personId }, { sort: { dueAt: -1 } });
  if (!action) throw new Error("no message was queued — is the campaign enabled?");

  // Pre-approved, because the operator asked for this one to go. Content is left empty on
  // purpose: the deployed sender renders it, so the links carry the deployed origin.
  await db.collection(C.actions).updateOne(
    { _id: action._id },
    {
      $set: { status: "queued", reviewedAt: new Date(), dueAt: new Date() },
      $unset: { "content.subject": "", "content.bodyMd": "", "content.bodyHtml": "", validation: "" },
    },
  );

  console.log("\nReady to send on the next tick of the DEPLOYED app.\n");
  line("to", to);
  line("person", personId);
  line("action", String(action._id));
  line("consent", "opt_in (pixel enabled)");
  console.log("\nTrigger it:");
  console.log("  curl -H \"authorization: Bearer $CRON_SECRET\" <APP_URL>/api/cron/tick\n");
  process.exit(0);
}

main();
