import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Pins everyone already in a conversation to the mailbox that has been having it.
 *
 * Until now the channel was chosen fresh at every touch and the first healthy one always
 * won, so a product with one connected mailbox behaved as though every person were bound
 * to it. Rotation makes that no longer true, and without this the first pass after the
 * change would hand hundreds of half-finished sequences to a mailbox their recipient has
 * never heard from — a stranger picking up somebody else's thread, and on Gmail a 404
 * rather than a send, because thread handles belong to the account that minted them.
 *
 * So: whoever sent their last message keeps them. New leads, and only new leads, get
 * spread across the mailboxes.
 *
 * Safe to run twice. A person who already carries an assignment is left alone, so this can
 * run before a deploy and again after one without moving anybody.
 *
 *   npm run backfill:assignments -- --dry     what it would do, writing nothing
 *   npm run backfill:assignments
 */
const DRY = process.argv.includes("--dry");

async function main(): Promise<void> {
  const db = await getDb();

  // Their most recent send is the one whose thread a follow-up would join, so it is the
  // one that decides. Grouping in the database rather than walking people keeps this a
  // single pass over the actions that actually went out.
  const rows = await db
    .collection(C.actions)
    .aggregate([
      { $match: { status: { $in: ["sent", "dispatched"] }, channelId: { $exists: true } } },
      { $sort: { sentAt: -1 } },
      { $group: { _id: "$personId", channelId: { $first: "$channelId" }, at: { $first: "$sentAt" } } },
    ])
    .toArray();

  const live = new Set(
    (await db.collection(C.channels).find({}, { projection: { _id: 1 } }).toArray()).map((c) =>
      String(c._id),
    ),
  );

  let assigned = 0;
  let alreadyHeld = 0;
  let channelGone = 0;
  const perChannel = new Map<string, number>();

  for (const row of rows) {
    const personId = String(row._id);
    if (!ObjectId.isValid(personId)) continue;

    const person = await db
      .collection(C.people)
      .findOne({ _id: new ObjectId(personId) }, { projection: { assignedChannelId: 1 } });
    if (!person) continue;
    if (person.assignedChannelId) {
      alreadyHeld++;
      continue;
    }

    // A channel that was deleted cannot be pinned to. Leaving these unassigned is the
    // honest outcome: they are reassigned on their next touch, which is the same thing
    // that would have happened to them anyway once their sender disappeared.
    const channelId = String(row.channelId);
    if (!live.has(channelId)) {
      channelGone++;
      continue;
    }

    perChannel.set(channelId, (perChannel.get(channelId) ?? 0) + 1);
    assigned++;
    if (DRY) continue;

    await db.collection(C.people).updateOne(
      { _id: new ObjectId(personId) },
      { $set: { assignedChannelId: channelId, assignedAt: row.at ?? new Date() } },
    );
  }

  const unassigned = await db
    .collection(C.people)
    .countDocuments({ assignedChannelId: { $exists: false } });

  console.log(`${DRY ? "would assign" : "assigned"}      ${assigned}`);
  console.log(`already assigned  ${alreadyHeld}`);
  console.log(`sender deleted    ${channelGone}`);
  for (const [channelId, n] of [...perChannel].sort((a, b) => b[1] - a[1])) {
    const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId) });
    console.log(`  ${channelId}  ${String(channel?.from ?? "provider default")}  ${n}`);
  }
  console.log(
    `\n${unassigned} people carry no assignment${
      DRY ? " (unchanged — this was a dry run)" : ""
    }. They pick a mailbox on their next touch.`,
  );
  process.exit(0);
}

void main();
