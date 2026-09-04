import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { dueAtFor } from "../engine/cadence.js";

/**
 * One message per person in the review queue, and the rest put back where they belong.
 *
 * A plan's first step is usually a welcome, and the engine has already queued a welcome of
 * its own the moment the lead landed — so the same person can be holding the identical
 * "your workspace is ready" twice, plus the day-three follow-up behind it. Nothing was
 * wrong with any of them individually; they only become a problem in front of a reviewer,
 * where approving the page sends someone three emails in one minute and two of them say
 * the same thing.
 *
 * Deduplicating at the review queue rather than at the plan is deliberate. The plan is a
 * strategy and it is not wrong to open with a welcome; what must not happen is two of them
 * going out. This is the last point where that is still preventable.
 *
 *   npm run dedupe:review
 *   npm run dedupe:review -- --commit
 */

const commit = process.argv.includes("--commit");
const db = await getDb();

/** First touch first, then plan order. The opener is the message a stranger should get. */
function rank(action: Document): number {
  const step = Number(action.planStepId);
  return Number.isFinite(step) ? step : 0;
}

const products = await db.collection(C.products).find({ status: "active" }).toArray();

for (const product of products) {
  const orgId = String(product.orgId);
  const productId = String(product._id);

  const waiting = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "awaiting_approval" })
    .toArray();
  if (waiting.length === 0) continue;

  const byPerson = new Map<string, Document[]>();
  for (const action of waiting) {
    const key = String(action.personId);
    byPerson.set(key, [...(byPerson.get(key) ?? []), action]);
  }

  const plan = { keep: 0, duplicate: 0, deferred: 0 };

  for (const [personId, actions] of byPerson) {
    if (actions.length === 1) {
      plan.keep++;
      continue;
    }

    const ordered = [...actions].sort((a, b) => rank(a) - rank(b));
    const [first, ...rest] = ordered;
    plan.keep++;

    const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) });
    const instance = await db
      .collection(C.goalInstances)
      .findOne({ orgId, productId, personId, status: "active" });
    const goal = instance
      ? await db.collection(C.goals).findOne({ orgId, productId, key: String(instance.goalKey) })
      : null;

    let position = 1;
    for (const action of rest) {
      // The same angle twice is a duplicate, not a sequence. Skipped rather than deferred:
      // there is no later date at which sending the identical message again is correct.
      if (String(action.angle) === String(first!.angle)) {
        plan.duplicate++;
        if (commit) {
          await db.collection(C.actions).updateOne(
            { _id: action._id },
            { $set: { status: "skipped", skipReason: `duplicate of the ${String(first!.angle)} already waiting for this person` } },
          );
        }
        continue;
      }

      // A genuinely later step. It is not wrong, it is early — so it goes back to the queue
      // with the gap its plan asked for, and will come back for review when it is due.
      const dueAt = dueAtFor({
        offsetDays: 3 * position,
        band: (person?.temp as { band?: string } | undefined)?.band,
        // Measured from the message about to be approved, not from a contact that never
        // happened: these people have never received anything.
        lastContactedAt: new Date(),
        configured: goal?.cadenceByTemp as never,
      });
      position++;
      plan.deferred++;
      if (commit) {
        await db.collection(C.actions).updateOne(
          { _id: action._id },
          {
            $set: { status: "queued", dueAt, deferReason: "waiting behind an earlier message to the same person" },
            $unset: { reviewedAt: "" },
          },
        );
      }
    }
  }

  console.log(`\n${String(product.name)}: ${waiting.length} waiting → ${byPerson.size} people`);
  console.log(`  keep for review   ${plan.keep}`);
  console.log(`  skip as duplicate ${plan.duplicate}`);
  console.log(`  defer to its date ${plan.deferred}`);
}

console.log(commit ? "\ncommitted\n" : "\ndry run — nothing written. Re-run with --commit to apply.\n");
process.exit(0);
