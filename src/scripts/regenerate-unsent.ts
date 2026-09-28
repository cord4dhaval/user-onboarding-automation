import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { writeFileSync } from "node:fs";

/**
 * Sends a campaign's unsent mail back to be written again, under whatever the rules are now.
 *
 * A change to how mail is written never reaches copy that is already composed: the words are
 * stored on the action, and review or send uses them as they are. recompose-held re-renders
 * the frame around the same words, which is the right tool after a template or merge-field
 * change and the wrong one here — the words themselves are what changed.
 *
 * A step counts as written while any action exists for it, whatever its status (advance.ts
 * writtenBy), so marking one skipped does not bring the step back: the action has to go. Each
 * one is written to backups/ first, and only queued, awaiting_approval and held are touched —
 * never a mail that was sent, is sending, or already failed (a failure that is requeued sends
 * a superseded mail).
 *
 * After it runs: the next tick's advance finds those steps unwritten and asks for words again,
 * and the Advance routine writes them on its next run. Mail that needs approval comes back to
 * Review. Nothing is sent by this script.
 *
 * --include-failed takes in the mail that died at the send gate as well, but only where the
 * lead is still active and the step is still in their current plan. A failure on a step the
 * plan has since replaced is left alone: rewriting it would send a mail the newer plan already
 * answered. Most of this campaign's failures are the price claim refused a second time to the
 * same person, which is what the one-mail-in-three price rule exists to stop.
 *
 *   npm run regen -- --goal=teamgrid_leads_v3            what would go
 *   npm run regen -- --goal=teamgrid_leads_v3 --apply    back it up and let it be rewritten
 *   npm run regen -- --goal=teamgrid_leads_v3 --include-failed --apply
 */

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

/** Mail nobody has read yet. "sending" is mid-flight and is left where it is. */
const UNSENT = ["queued", "awaiting_approval", "held"];

async function main(): Promise<void> {
  const goalKey = arg("goal");
  const apply = process.argv.includes("--apply");
  if (!goalKey) throw new Error("Pass a campaign: npm run regen -- --goal=<goalKey> [--apply]");

  const db = await getDb();
  const instances = await db.collection(C.goalInstances).find({ goalKey }, { projection: { _id: 1, personId: 1, status: 1 } }).toArray();
  if (instances.length === 0) throw new Error(`No campaign runs with goalKey "${goalKey}".`);
  const ids = instances.map((i) => String(i._id));

  const unsent = await db.collection(C.actions).find({ goalInstanceId: { $in: ids }, status: { $in: UNSENT } }).toArray();

  // Mail that died at the send gate, where the lead is still going and the plan still has that
  // step. Anything else stays: a failure whose step the plan replaced is not waiting to be sent.
  if (process.argv.includes("--include-failed")) {
    const active = new Map(instances.filter((i) => i.status === "active").map((i) => [String(i._id), String(i.currentPlanId ?? "")]));
    const failed = await db.collection(C.actions).find({ goalInstanceId: { $in: [...active.keys()] }, status: "failed" }).toArray();
    const planIds = [...new Set([...active.values()].filter((id) => ObjectId.isValid(id)))].map((id) => new ObjectId(id));
    const plans = await db.collection(C.plans).find({ _id: { $in: planIds } }, { projection: { steps: 1 } }).toArray();
    const stepsOf = new Map(plans.map((p) => [String(p._id), new Set(((p.steps ?? []) as Array<{ id?: unknown }>).map((st) => Number(st.id)))]));
    const live = failed.filter((a) => stepsOf.get(active.get(String(a.goalInstanceId)) ?? "")?.has(Number(a.planStepId)));
    console.log(`failed mail: ${failed.length}, of which ${live.length} on a step still in the lead's plan — those are taken too.`);
    for (const a of live) {
      const why = ((a.validation as { hardFails?: unknown[] } | undefined)?.hardFails ?? [])[0];
      console.log(`  · failed            ${String(why ?? "no reason recorded").slice(0, 70)}`);
    }
    unsent.push(...live);
  }
  const sent = await db.collection(C.actions).countDocuments({ goalInstanceId: { $in: ids }, status: { $in: ["sent", "dispatched"] } });
  console.log(`${goalKey}: ${instances.length} leads (${instances.filter((i) => i.status === "active").length} active), ${sent} mails already sent — those stay.\n`);
  console.log(`unsent mail: ${unsent.length}`);
  for (const [status, count] of Object.entries(unsent.reduce<Record<string, number>>((m, a) => ({ ...m, [String(a.status)]: (m[String(a.status)] ?? 0) + 1 }), {}))) {
    console.log(`  ${status.padEnd(18)} ${count}`);
  }
  for (const a of unsent.slice(0, 8)) {
    console.log(`  · ${String(a.status).padEnd(18)} ${String((a.content as { subject?: unknown } | undefined)?.subject ?? "(not written yet)").slice(0, 56)}`);
  }
  if (unsent.length > 8) console.log(`  · … and ${unsent.length - 8} more`);

  if (unsent.length === 0) {
    console.log("\nnothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nNothing written. Re-run with --apply.");
    console.log("Deploy the writing change FIRST, and push the routine prompt to its trigger (npm run prompts),");
    console.log("or the same words come back.");
    return;
  }

  const file = `backups/unsent-${goalKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(unsent, null, 1));
  const gone = await db.collection(C.actions).deleteMany({ _id: { $in: unsent.map((a) => a._id) }, status: { $in: [...UNSENT, "failed"] } });
  console.log(`\nbacked up ${unsent.length} to ${file}`);
  console.log(`returned ${gone.deletedCount} steps to be written again.`);
  console.log("The next tick asks for words; the Advance routine writes them and Review fills up again.");
}

void main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
