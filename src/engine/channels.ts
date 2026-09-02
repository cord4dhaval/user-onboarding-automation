import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { ChannelKey } from "../schemas/common.js";

export interface ChannelPick {
  channelId: string;
  key: ChannelKey;
  reason: string;
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
): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  return db
    .collection(C.channels)
    .find({ orgId, productId, key: { $in: chain }, enabled: true })
    .toArray();
}

/**
 * Walks the goal's channel priority chain and returns the first channel that can
 * actually carry this touch. Never sends on more than one: the same message arriving
 * by email and WhatsApp at the same moment reads as spam, not as thoroughness.
 */
export async function pickChannel(
  orgId: string,
  productId: string,
  chain: ChannelKey[],
  person: { consent: { state: string }; stage?: string },
): Promise<ChannelPick | null> {
  return pickChannelFrom(await loadChannels(orgId, productId, chain), chain, person);
}

/** The decision itself, over channels already in hand. No I/O, so a batch can call it freely. */
export function pickChannelFrom(
  channels: Record<string, unknown>[],
  chain: ChannelKey[],
  person: { consent: { state: string }; stage?: string },
): ChannelPick | null {
  const audience = person.stage && person.stage !== "lead" ? "existing_user" : "cold";

  for (const key of chain) {
    const channel = channels.find((c) => c.key === key);
    if (!channel) continue;
    if (channel.status !== "healthy") continue;

    const caps = channel.capabilities as { consentRequired?: boolean } | undefined;
    if (caps?.consentRequired && person.consent.state !== "opt_in") continue;

    const policy = channel.policy as { audience?: string[] } | undefined;
    if (policy?.audience && !policy.audience.includes(audience)) continue;

    const governor = channel.governor as { dailyCap: number; sentToday: number } | undefined;
    if (governor && governor.sentToday >= governor.dailyCap) continue;

    return { channelId: String(channel._id), key: key as ChannelKey, reason: "first healthy channel in chain" };
  }
  return null;
}
