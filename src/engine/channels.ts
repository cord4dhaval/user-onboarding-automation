import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { ChannelKey } from "../schemas/common.js";

export interface ChannelPick {
  channelId: string;
  key: ChannelKey;
  reason: string;
  /**
   * True when this person had no mailbox yet and this pick is the one that gives them
   * one. The caller writes it back; everything after reads it rather than choosing again.
   */
  assigned?: boolean;
}

/**
 * A channel as planning sees it: the stored document, plus how many people are already
 * bound to it.
 *
 * Rotation balances leads rather than sends. A lead assigned today keeps sending on that
 * mailbox for weeks, so spreading each day's sends evenly would still leave whichever
 * mailbox went first owning every sequence — the count that matters is how many
 * conversations a mailbox carries, not how many messages it happened to send this morning.
 */
export type PooledChannel = Record<string, unknown> & { assignedLeads: number };

/** What a person needs to carry for a channel decision to be made about them. */
interface Candidate {
  consent: { state: string };
  stage?: string;
  assignedChannelId?: string;
  lastReplyAt?: Date;
}

/**
 * Split from the decision below so a batch of arrivals reads the channels once rather
 * than once per person. The chain is a handful of documents and identical for every
 * person in the batch; fetching it per person was most of the cost of ingesting a
 * spreadsheet.
 */
export async function loadChannels(
  orgId: string,
  productId: string,
  chain: ChannelKey[],
): Promise<PooledChannel[]> {
  const db = await getDb();
  const channels = await db
    .collection(C.channels)
    .find({ orgId, productId, key: { $in: chain }, enabled: true })
    .toArray();
  if (channels.length === 0) return [];

  const ids = channels.map((c) => String(c._id));
  const rows = await db
    .collection(C.people)
    .aggregate([
      { $match: { orgId, productId, assignedChannelId: { $in: ids } } },
      { $group: { _id: "$assignedChannelId", n: { $sum: 1 } } },
    ])
    .toArray();
  const counts = new Map(rows.map((r) => [String(r._id), Number(r.n)]));

  return channels.map((c) =>
    Object.assign(c, { assignedLeads: counts.get(String(c._id)) ?? 0 }),
  ) as PooledChannel[];
}

/** Whether this channel may carry this touch for this person, ignoring how loaded it is. */
function eligible(channel: Record<string, unknown>, key: ChannelKey, person: Candidate): boolean {
  if (channel.key !== key) return false;
  if (channel.status !== "healthy") return false;

  const caps = channel.capabilities as { consentRequired?: boolean } | undefined;
  if (caps?.consentRequired && person.consent.state !== "opt_in") return false;

  const audience = person.stage && person.stage !== "lead" ? "existing_user" : "cold";
  const policy = channel.policy as { audience?: string[] } | undefined;
  if (policy?.audience && !policy.audience.includes(audience)) return false;

  return true;
}

/**
 * Walks the goal's channel priority chain and returns the channel that should carry this
 * touch. Never sends on more than one: the same message arriving by email and WhatsApp at
 * the same moment reads as spam, not as thoroughness.
 */
export async function pickChannel(
  orgId: string,
  productId: string,
  chain: ChannelKey[],
  person: Candidate,
): Promise<ChannelPick | null> {
  return pickChannelFrom(await loadChannels(orgId, productId, chain), chain, person);
}

/** The decision itself, over channels already in hand. No I/O, so a batch can call it freely. */
export function pickChannelFrom(
  channels: PooledChannel[],
  chain: ChannelKey[],
  person: Candidate,
): ChannelPick | null {
  // The mailbox this person is already talking to beats every balance consideration.
  //
  // A sequence that changes sender halfway is not a cosmetic problem. Provider thread
  // handles belong to one mailbox — handing Gmail a threadId minted in a different account
  // is a 404, not a differently-threaded message — and to the person on the other end a
  // new address continuing an old conversation reads as a stranger who has been reading
  // their mail.
  const held = person.assignedChannelId
    ? channels.find((c) => String(c._id) === String(person.assignedChannelId))
    : undefined;
  if (held && chain.includes(held.key as ChannelKey) && eligible(held, held.key as ChannelKey, person)) {
    return {
      channelId: String(held._id),
      key: held.key as ChannelKey,
      reason: "already sending to this person",
    };
  }

  // Their mailbox has gone — disabled, unhealthy, or no longer serving this audience.
  //
  // Someone who has answered stays with it and waits for it to come back. Their reply
  // lives in a thread only that mailbox can see, and moving them would both orphan the
  // answer and reply to a conversation from an address they have never heard from.
  // Someone who never answered has nothing to lose by being moved on.
  if (person.assignedChannelId && person.lastReplyAt) return null;

  for (const key of chain) {
    const candidates = channels.filter((c) => eligible(c, key, person));
    if (candidates.length === 0) continue;

    // Fewest leads wins. The id breaks ties so the same batch assigns the same way twice,
    // which is what makes a dry run worth reading.
    candidates.sort(
      (a, b) => a.assignedLeads - b.assignedLeads || String(a._id).localeCompare(String(b._id)),
    );
    const chosen = candidates[0]!;

    // Counted here rather than after the write. Every lead in one ingest is decided against
    // the same loaded array, so without this they all read the same starting counts and the
    // whole batch lands on one mailbox — which is the bug this function exists to fix.
    chosen.assignedLeads += 1;

    // The cap is deliberately not part of the choice. `governor.sentToday` only ever
    // climbs, and the real limit is enforced at send time in fireDue from rows that
    // actually went out; a mailbox that is full today is still the right mailbox for a
    // sequence that runs for a fortnight, and fireDue delays rather than reroutes.
    return {
      channelId: String(chosen._id),
      key,
      reason:
        candidates.length > 1
          ? `fewest leads of ${candidates.length} healthy ${key} channels`
          : `only healthy ${key} channel`,
      assigned: true,
    };
  }
  return null;
}

/**
 * Why this person got no channel, in words that can be shown on their row.
 *
 * "No healthy channel" is true of both cases and useful in neither: one is a product with
 * nothing connected, the other is one mailbox switched off under a conversation that is
 * already running, and only the second is fixed by switching it back on.
 */
export function skipReason(person: Candidate, channels: PooledChannel[]): string {
  if (!person.assignedChannelId) return "no healthy channel";
  const held = channels.find((c) => String(c._id) === String(person.assignedChannelId));
  if (person.lastReplyAt) {
    return held
      ? "their sender is not healthy, and they have replied — held rather than moved"
      : "their sender is switched off, and they have replied — held rather than moved";
  }
  return "no healthy channel";
}

/**
 * Writes back the mailbox a batch just handed out.
 *
 * One call for the whole batch: assignment is decided per person but it is the same fact
 * written the same way, and 200 arrivals should not be 200 round trips.
 */
export async function persistAssignments(
  pairs: Array<{ personId: string; channelId: string }>,
): Promise<void> {
  if (pairs.length === 0) return;
  const db = await getDb();
  const assignedAt = new Date();
  await db.collection(C.people).bulkWrite(
    pairs.map(({ personId, channelId }) => ({
      updateOne: {
        filter: { _id: new ObjectId(personId) },
        update: { $set: { assignedChannelId: channelId, assignedAt } },
      },
    })),
    { ordered: false },
  );
}
