import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveTemplateFor } from "../engine/templates.js";
import { dueAtFor } from "../engine/cadence.js";
import { nextSendableAt } from "../engine/time.js";

/**
 * Returns messages that failed for reasons that no longer exist.
 *
 * Two faults killed real mail. Actions written by a session carried no template id, and the
 * send path treated that as a missing document rather than as a template to be chosen, so
 * seventy-one people were dropped mid-sequence. Another fifty were refused by the provider's
 * hourly cap, which the channel never declared and the governor therefore never paced
 * against. Both are fixed; the messages are still dead, because nothing re-queues a failure.
 *
 * Only failures whose cause is genuinely gone are touched. A message that failed validation
 * or was refused for content is left exactly where it is — re-sending those would be
 * repeating a mistake rather than undoing one.
 *
 *   npm run repair:dead -- --dry
 *   npm run repair:dead -- --commit
 */

const commit = process.argv.includes("--commit");
const toId = (value: unknown) => new ObjectId(String(value));
const db = await getDb();

/** The two errors this repairs, and nothing else. */
const REPAIRABLE = [
  { pattern: /missing person, goal, channel or template/, cause: "no template id on the action" },
  { pattern: /hourly_cap/, cause: "provider hourly cap, now paced by the governor" },
];

const products = await db.collection(C.products).find({ status: "active" }).toArray();

for (const product of products) {
  const orgId = String(product.orgId);
  const productId = String(product._id);

  const failed = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "failed" })
    .toArray();
  if (failed.length === 0) continue;

  console.log(`\n${String(product.name)}: ${failed.length} failed action(s)`);

  const plan = { requeue: 0, skipUnrepairable: 0, skipSuppressed: 0, skipNoTemplate: 0, skipSpent: 0, skipSuperseded: 0 };
  const reasons = new Map<string, number>();

  for (const action of failed) {
    const error = String(action.error ?? "");
    const match = REPAIRABLE.find((r) => r.pattern.test(error));
    if (!match) {
      plan.skipUnrepairable++;
      reasons.set(error.slice(0, 60) || "(no error recorded)", (reasons.get(error.slice(0, 60) || "(no error recorded)") ?? 0) + 1);
      continue;
    }

    const person = await db.collection(C.people).findOne({ _id: toId(action.personId) });
    const instance = await db.collection(C.goalInstances).findOne({ _id: toId(action.goalInstanceId) });
    if (!person || !instance) {
      plan.skipUnrepairable++;
      continue;
    }

    // Somebody who has since unsubscribed, replied or been suppressed must not receive a
    // message that was written before any of that happened.
    if (person.suppressedAt || person.lifecycle === "suppressed" || person.lastReplyAt) {
      plan.skipSuppressed++;
      continue;
    }
    if (instance.status !== "active") {
      plan.skipSpent++;
      continue;
    }

    // A step that has since been written again — by a later plan, or by the engine — is
    // already on its way. Sending this one too would put the same touch out twice.
    const alreadyPending = await db.collection(C.actions).countDocuments({
      orgId,
      goalInstanceId: String(action.goalInstanceId),
      status: { $in: ["queued", "awaiting_approval", "sending", "sent", "dispatched"] },
      planStepId: action.planStepId ?? { $exists: false },
    });
    if (alreadyPending > 0) {
      plan.skipSuperseded++;
      continue;
    }

    const template = await resolveTemplateFor({
      orgId,
      productId,
      channel: String(action.channel),
      segment: (person.belief as { segment?: string } | undefined)?.segment,
      touchesSpent: Number((instance.spent as { touches?: number } | undefined)?.touches ?? 0),
    });
    if (!template) {
      plan.skipNoTemplate++;
      continue;
    }

    // Re-dated rather than sent immediately. Somebody mid-sequence is paced from their last
    // contact, so a week of sequence does not arrive in one inbox in one minute — which
    // would be worse than the original fault. Somebody who has never been contacted has no
    // gap to honour and goes as soon as their local clock allows: their welcome is late
    // already, and delaying it further serves nobody.
    //
    // The quiet-hours guard is applied here rather than left to the send path, which does
    // not check it — it is applied when a first touch is queued, and this is a first touch
    // being queued again.
    const goal = await db
      .collection(C.goals)
      .findOne({ orgId, productId, key: String(instance.goalKey) });
    const quietHours = (goal?.schedule as { quietHours?: [number, number] } | undefined)?.quietHours;
    const paced = dueAtFor({
      offsetDays: 1,
      band: (person.temp as { band?: string } | undefined)?.band,
      lastContactedAt: person.lastContactedAt as Date | undefined,
    });
    const dueAt = person.lastContactedAt
      ? paced
      : nextSendableAt(paced, String(person.timezone ?? "UTC"), "batch", quietHours);

    plan.requeue++;
    if (commit) {
      await db.collection(C.actions).updateOne(
        { _id: action._id },
        {
          $set: { status: "queued", dueAt, repairedAt: new Date(), repairedBecause: match.cause },
          $unset: { error: "", claimedAt: "" },
        },
      );
    }
  }

  console.log(`  requeue                ${plan.requeue}`);
  console.log(`  skip: suppressed/replied ${plan.skipSuppressed}`);
  console.log(`  skip: campaign closed  ${plan.skipSpent}`);
  console.log(`  skip: already resent   ${plan.skipSuperseded}`);
  console.log(`  skip: no template      ${plan.skipNoTemplate}`);
  console.log(`  skip: not repairable   ${plan.skipUnrepairable}`);
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`        ${n}x ${reason}`);
  }
}

console.log(commit ? "\ncommitted\n" : "\ndry run — nothing written. Re-run with --commit to apply.\n");
process.exit(0);
