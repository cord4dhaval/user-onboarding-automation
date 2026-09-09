import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { loadChannels, pickChannelFrom } from "../engine/channels.js";
import type { ChannelKey } from "../schemas/common.js";

/**
 * Moves everyone off one mailbox and onto the others.
 *
 * Switching a channel off is enough to stop it being chosen for anything new — the picker
 * skips it and fireDue refuses to send on it. It is not enough to move what is already
 * bound to it: those people keep pointing at a mailbox that will never send again, and
 * their queued messages sit at "channel is disabled" until somebody notices. Retiring a
 * sender is therefore a migration, not a toggle, and this is it.
 *
 * Two things move together, and they have to agree. The person's assignment decides who
 * writes to them next; the rows already queued for them carry a channel of their own,
 * written when they were planned. Leaving either behind produces a lead assigned to one
 * mailbox with a message waiting to go out from another.
 *
 * Anyone who has replied is left where they are. Their answer lives in a thread only the
 * retiring mailbox can see, and continuing it from a new address is worse than waiting —
 * it reads to them as a stranger who has been reading their mail. Pass --include-replied
 * to override that, which is the right call when the mailbox is not coming back.
 *
 *   npm run retire:channel -- <channelId> --dry
 *   npm run retire:channel -- <channelId>
 *   npm run retire:channel -- <channelId> --include-replied
 */
const [channelId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DRY = process.argv.includes("--dry");
const INCLUDE_REPLIED = process.argv.includes("--include-replied");

async function main(): Promise<void> {
  if (!channelId || !ObjectId.isValid(channelId)) {
    console.error("usage: npm run retire:channel -- <channelId> [--dry] [--include-replied]");
    process.exit(1);
  }
  const db = await getDb();

  const retiring = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId) });
  if (!retiring) {
    console.error(`no channel ${channelId}`);
    process.exit(1);
  }
  const orgId = String(retiring.orgId);
  const productId = String(retiring.productId);
  const key = String(retiring.key) as ChannelKey;
  console.log(`retiring ${channelId}  ${String(retiring.from ?? "provider default")}  key=${key}`);

  // The pool the picker will choose from, minus the one being retired — which may still be
  // healthy at this moment, and would otherwise be handed straight back.
  const pool = (await loadChannels(orgId, productId, [key])).filter(
    (c) => String(c._id) !== channelId,
  );
  if (pool.length === 0) {
    console.error("nothing else on this key is enabled. Connect a mailbox before retiring this one.");
    process.exit(1);
  }
  console.log(`onto ${pool.length} mailbox(es): ${pool.map((c) => String(c.from ?? c._id)).join(", ")}\n`);

  // Everyone this mailbox is responsible for, which is two groups and not one.
  //
  // The obvious group is assigned to it. The second is assigned to nothing and still has
  // rows queued against it: they were planned onto it before assignment existed, and they
  // have never been sent to, so no backfill could have found them. Missing them leaves
  // messages that hold at "channel is disabled" for a mailbox nobody will ever switch on.
  const assigned = await db
    .collection(C.people)
    .find({ orgId, productId, assignedChannelId: channelId })
    .toArray();

  const pendingStatuses = ["queued", "awaiting_approval", "planned"];
  const stranded = await db.collection(C.actions).distinct("personId", {
    orgId,
    productId,
    channelId,
    status: { $in: pendingStatuses },
  });
  const known = new Set(assigned.map((p) => String(p._id)));
  const extra = await db
    .collection(C.people)
    .find({
      _id: {
        $in: stranded
          .filter((id) => !known.has(String(id)) && ObjectId.isValid(String(id)))
          .map((id) => new ObjectId(String(id))),
      },
    })
    .toArray();

  const people = [...assigned, ...extra];
  if (extra.length > 0) console.log(`${extra.length} of them are unassigned with work already queued here\n`);

  let moved = 0;
  let heldBack = 0;
  const perDestination = new Map<string, number>();
  const movedIds: string[] = [];

  for (const person of people) {
    if (person.lastReplyAt && !INCLUDE_REPLIED) {
      heldBack++;
      continue;
    }

    // Decided by the same function the engine uses, over the same pool, so the spread this
    // produces is the spread the next batch of arrivals would have produced. The assignment
    // is cleared first: the picker's whole job is to honour an existing one.
    const pick = pickChannelFrom(pool, [key], { ...person, assignedChannelId: undefined } as never);
    if (!pick) {
      heldBack++;
      continue;
    }

    perDestination.set(pick.channelId, (perDestination.get(pick.channelId) ?? 0) + 1);
    movedIds.push(String(person._id));
    moved++;
    if (DRY) continue;

    await db
      .collection(C.people)
      .updateOne(
        { _id: person._id },
        { $set: { assignedChannelId: pick.channelId, assignedAt: new Date() } },
      );

    // Everything still waiting to go out for them. A sent row is history and is left exactly
    // as it was — it records which mailbox really sent it, and rewriting that would make the
    // per-channel counts lie about what happened.
    await db.collection(C.actions).updateMany(
      {
        orgId,
        productId,
        personId: String(person._id),
        channelId,
        status: { $in: pendingStatuses },
      },
      { $set: { channelId: pick.channelId } },
    );
  }

  // What would still be pointing at the retired channel once the moves above are done:
  // rows for people who were never assigned anywhere, or who were held back. These hold at
  // "channel is disabled" forever, so the number is worth seeing before the switch is flipped
  // rather than after. Excluding the moved people by hand keeps a dry run honest — otherwise
  // it reports the work it was about to do as work left over.
  const orphans = await db.collection(C.actions).countDocuments({
    orgId,
    productId,
    channelId,
    status: { $in: pendingStatuses },
    personId: { $nin: movedIds },
  });

  console.log(`${DRY ? "would move" : "moved"}   ${moved} people`);
  for (const [id, n] of [...perDestination].sort((a, b) => b[1] - a[1])) {
    const to = pool.find((c) => String(c._id) === id);
    console.log(`     ${String(n).padStart(4)}  ${String(to?.from ?? id)}`);
  }
  console.log(`held back  ${heldBack}${heldBack > 0 && !INCLUDE_REPLIED ? " (replied — rerun with --include-replied to move them too)" : ""}`);
  console.log(`still queued on the retired channel: ${orphans}`);
  if (DRY) console.log("\nnothing was written — this was a dry run");
  else
    console.log(
      `\nNow switch ${channelId} to disabled in its settings. Until you do, it stays in the rotation.`,
    );
  process.exit(0);
}

void main();
