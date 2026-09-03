import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { runSource } from "../engine/runSource.js";
import { fireDue } from "../engine/fireDue.js";
import { resolveChannelAdapter } from "../engine/adapters.js";

/**
 * One lead, one message, through every path the real system uses — so that what the test
 * proves is the system rather than a shortcut around it.
 *
 *   npm run test:track -- --to=you+t1@gmail.com
 *
 * It stops at the approval gate on purpose. Nothing here sends: a human approves the
 * message in the console, the next tick sends it, and the point of the exercise is what
 * comes back afterwards.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const line = (label: string, value: string) => console.log(`  ${label.padEnd(22)} ${value}`);

async function main(): Promise<void> {
  const to = arg("to");
  if (!to?.includes("@")) throw new Error("Pass an address: npm run test:track -- --to=you+t1@gmail.com");

  const origin = process.env.APP_URL?.replace(/\/$/, "");
  const db = await getDb();

  const source = await db.collection(C.sources).findOne({ kind: "excel_upload", enabled: true });
  if (!source) throw new Error("no enabled upload source to ingest through");
  const orgId = String(source.orgId);
  const productId = String(source.productId);

  console.log("\nSetup");
  line("source", `${String(source.name)} → ${String(source.defaultGoalKey)}`);
  line("APP_URL", origin || "BLANK — links will not be wrapped");
  if (!origin) {
    console.log("\n  Without APP_URL nothing can be tracked. Set it and run again.\n");
    process.exit(1);
  }

  // Company deliberately left empty. A bare personal address is the case the planner has
  // least to work with, and the one this whole change was built around.
  const summary = await runSource(String(source._id), [
    { Email: to, Name: "Tracking Probe", Title: "", Company: "", TZ: "Asia/Kolkata" },
  ] as never);
  console.log("\nIngest");
  line("created", String(summary.created));
  line("already known", String(summary.attachedToExisting));

  const person = await db.collection(C.people).findOne({ orgId, productId, primaryEmail: to });
  if (!person) throw new Error("person was not created — is this address suppressed?");
  const personId = String(person._id);
  line("email kind", String(person.emailKind));
  line("company domain", person.companyDomain ? String(person.companyDomain) : "none (correct for a free mailbox)");
  line("consent", String((person.consent as { state?: string })?.state));

  const consent = String((person.consent as { state?: string })?.state);
  line(
    "will track",
    consent === "opt_in" ? "clicks and opens" : consent === "legitimate_interest" ? "clicks only, no pixel" : "nothing",
  );

  // The same call the cron tick makes, so approval, governors and validation all apply.
  const fired = await fireDue({
    orgId,
    productId,
    dryRun: false,
    adapterFor: (channelId) => resolveChannelAdapter(orgId, channelId),
    now: new Date(),
    limit: 5,
  });
  console.log("\nQueue");
  line("claimed", String(fired.claimed));
  line("held for approval", String(fired.heldForApproval));
  line("sent", String(fired.sent));
  for (const b of fired.blocked) line("blocked", `${b.person}: ${b.reason}`);
  for (const f of fired.failed) line("failed", `${f.person}: ${f.error}`);

  const action = await db
    .collection(C.actions)
    .findOne({ orgId, productId, personId }, { sort: { dueAt: -1 } });

  console.log("\nNext");
  if (!action) {
    console.log("  No message was queued. Check that the campaign is enabled and has a plan.\n");
    process.exit(0);
  }
  line("action", String(action._id));
  line("status", String(action.status));
  console.log(`
  1. Approve it:   ${origin}/products/${productId}/review
  2. Wait for the next tick, or hit /api/cron/tick yourself.
  3. In the mail, view source. Every href should point at
     ${origin}/api/t/c/...  — then click one.
  4. Watch it land:
     ${origin}/products/${productId}/library/${personId}
     The touch should read "clicked <time>", and after the following
     tick the temperature should turn hot.
`);
  process.exit(0);
}

main();
