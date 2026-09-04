import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { demoteToMachine } from "../engine/engagement.js";
import { recomputeTemps } from "../engine/temp.js";
import { looksAutomated, MACHINE_WINDOW_MS } from "../engine/tracking.js";

/**
 * Sorts signals already on record into the ones a person made and the ones a machine made.
 *
 * Everything collected before machines were told apart landed in one column, and on this
 * product the majority of it was a mail security gateway: five of eight counted clicks on
 * one campaign arrived six to sixty-two seconds after the send, each followed a second
 * later by the same gateway fetching the unsubscribe link. Those five people were shown as
 * interested, were graded on it, and taught the shared timing priors.
 *
 * Three things are put right here, in order: the signal is moved to the machine column,
 * the shared prior it inflated is wound back, and the notification that told someone a
 * scanner had clicked is withdrawn. Then temperatures are recomputed, because a band worked
 * out from a gateway's fetch is a lead marked hot for no reason.
 *
 *   npx tsx --env-file=.env src/scripts/reclassify-signals.ts [--apply]
 *
 * Without --apply it only reports, which is the right default for a script that rewrites
 * measurements people have already read.
 */
const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const db = await getDb();
  const scope = new Set<string>();
  let moved = 0;

  for (const type of ["clicked", "opened"] as const) {
    const field = type === "opened" ? "firstOpenedAt" : "firstClickedAt";
    const actions = await db
      .collection(C.actions)
      .find({ [field]: { $exists: true } }, { projection: { orgId: 1, productId: 1, personId: 1, sentAt: 1, [field]: 1 } })
      .toArray();

    for (const action of actions) {
      const at = new Date(String(action[field]));
      // An action with no send date has not been sent, and a link reached in a draft is
      // already reported separately as exactly that. Reclassifying it here would count the
      // same oddity twice under two names.
      if (!action.sentAt) continue;
      if (!looksAutomated({ sentAt: action.sentAt as Date, at })) continue;

      const gap = Math.round((at.getTime() - new Date(String(action.sentAt)).getTime()) / 1000);
      const person = await db
        .collection(C.people)
        .findOne({ _id: new ObjectId(String(action.personId)) }, { projection: { name: 1, primaryEmail: 1 } });
      console.log(
        `  ${type} +${gap}s  ${String(person?.name ?? person?.primaryEmail ?? action.personId)}`,
      );

      if (APPLY && (await demoteToMachine(action._id, type))) {
        moved++;
        scope.add(`${String(action.orgId)}|${String(action.productId)}`);
        // The notice raised for this signal said a person had clicked. Withdrawn only if
        // nothing human is left for them, so somebody who also clicked for real keeps it.
        const stillHuman = await db
          .collection(C.actions)
          .countDocuments({ personId: String(action.personId), [field]: { $exists: true } }, { limit: 1 });
        if (stillHuman === 0) {
          await db
            .collection(C.notifications)
            .deleteMany({ dedupeKey: `engagement:${type}:${String(action.personId)}` });
        }
      }
    }
  }

  // A second pass, always run, because the first version of this script moved the stamp
  // without marking the signal it came from — the two timestamps were compared through
  // String(), which drops milliseconds. Anything already moved is repaired here, and on a
  // clean database this loop finds nothing.
  if (APPLY) {
    for (const type of ["clicked", "opened"] as const) {
      const field = type === "opened" ? "firstMachineOpenedAt" : "firstMachineClickedAt";
      for (const action of await db
        .collection(C.actions)
        .find({ [field]: { $exists: true } }, { projection: { [field]: 1, signals: 1 } })
        .toArray()) {
        const stamp = new Date(String(action[field])).getTime();
        const signals = ((action.signals ?? []) as Array<Record<string, unknown>>).map((signal) =>
          signal.type === type && !signal.bot && new Date(String(signal.at)).getTime() === stamp
            ? { ...signal, bot: true }
            : signal,
        );
        if (signals.some((signal, i) => signal !== (action.signals as unknown[])[i])) {
          await db.collection(C.actions).updateOne({ _id: action._id }, { $set: { signals } });
          console.log(`  flagged a ${type} signal left unmarked by an earlier run`);
        }
      }
    }
  }

  // Any notice still claiming a person clicked, for a person with no click on anything we
  // actually sent. Covers the reclassified scanners and the links reached in drafts that
  // never went out — both told somebody a lead was warm when none was.
  if (APPLY) {
    for (const notice of await db
      .collection(C.notifications)
      .find({ dedupeKey: /^engagement:(clicked|opened):/ })
      .toArray()) {
      const [, type, personId] = String(notice.dedupeKey).split(":");
      const field = type === "opened" ? "firstOpenedAt" : "firstClickedAt";
      const real = await db
        .collection(C.actions)
        .countDocuments(
          { personId, status: { $in: ["sent", "dispatched"] }, [field]: { $exists: true } },
          { limit: 1 },
        );
      if (real === 0) {
        await db.collection(C.notifications).deleteOne({ _id: notice._id });
        console.log(`  withdrew "${String(notice.title)}" — nothing sent to them was ${type}`);
      }
    }
  }

  if (!APPLY) {
    console.log(`\nWould move the signals above (inside ${MACHINE_WINDOW_MS / 1000}s of the send). Re-run with --apply.`);
    process.exit(0);
  }

  for (const key of scope) {
    const [orgId = "", productId = ""] = key.split("|");
    const summary = await recomputeTemps(orgId, productId, 500);
    console.log(`\n${productId}: ${summary.changed} of ${summary.examined} temperatures changed.`);
  }
  console.log(`\n${moved} signal${moved === 1 ? "" : "s"} moved to the machine column.`);
  process.exit(0);
}

void main();
