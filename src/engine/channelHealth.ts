import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { grantedCapabilities } from "../auth/google.js";
import { productionAccess } from "./sesIdentity.js";

/**
 * Whether a channel is actually able to do the job, decided from what it is wired to rather
 * than from what somebody ticked while setting it up.
 *
 * The rule that matters is the SES one: a domain identity can send and can never receive,
 * so a channel sending through it needs a Google connection alongside for the replies to
 * come back through. Left to the setup wizard, that pairing holds only for people who
 * finish the wizard — and a half-finished setup sends perfectly well while every answer
 * anyone writes back disappears. Campaigns keep chasing people who already replied, which
 * is the single worst thing this system can do to a customer's reputation.
 *
 * So it is a health condition. The engine skips channels that are not healthy, which means
 * an incomplete SES setup sends nothing at all rather than sending blind.
 */

export interface ChannelHealth {
  healthy: boolean;
  /** What to tell somebody looking at the Channels page. Empty when healthy. */
  reasons: string[];
}

export async function evaluateChannel(orgId: string, channelId: string): Promise<ChannelHealth> {
  const db = await getDb();
  const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId), orgId });
  if (!channel) return { healthy: false, reasons: ["this channel no longer exists"] };

  const connection = await db
    .collection(C.connections)
    .findOne({ _id: new ObjectId(String(channel.connectionId)) });
  if (!connection) return { healthy: false, reasons: ["the connection this channel sends through is gone"] };

  const reasons: string[] = [];

  if (connection.authType === "oauth2" && connection.provider === "google") {
    if (!grantedCapabilities((connection.scopes ?? []) as string[]).send) {
      reasons.push("this mailbox was connected without permission to send — reconnect it");
    }
  }

  if (connection.authType === "ses") {
    const identity = connection.ses as { domain?: string; status?: string } | undefined;
    if (identity?.status !== "verified") {
      reasons.push(
        identity?.status === "failed"
          ? `${identity?.domain ?? "this domain"} was not verified in time — add the DNS records and start again`
          : `${identity?.domain ?? "this domain"} is waiting on its DNS records`,
      );
    }

    // The pairing. Stated as two separate failures because they are two different fixes:
    // one is "connect Gmail", the other is "you connected it without read access".
    const inboxId = channel.inboxConnectionId ? String(channel.inboxConnectionId) : null;
    const inbox = inboxId
      ? await db.collection(C.connections).findOne({ _id: new ObjectId(inboxId), authType: "oauth2", provider: "google" })
      : null;

    if (!inbox) {
      reasons.push("sending from your own domain still needs a Gmail account connected, so replies can be read");
    } else if (!grantedCapabilities((inbox.scopes ?? []) as string[]).read) {
      reasons.push("the connected Gmail account cannot read replies — reconnect it and allow reading");
    }

    // A verified domain in a sandboxed account is a channel that passes every check and
    // fails every real send: Amazon refuses each message to an address nobody verified, one
    // at a time, after the touch has already been spent. Reported here instead, so the
    // engine skips the channel and no campaign discovers it a message at a time.
    try {
      const account = await productionAccess();
      if (!account.enabled) {
        reasons.push(
          "this AWS account is still in the Amazon SES sandbox, so it can only send to addresses you have verified — request production access",
        );
      }
      if (!account.sendingEnabled) {
        reasons.push("Amazon has paused sending for this account — check the SES reputation dashboard");
      }
    } catch {
      // Deliberately not a reason. Asking AWS can fail for a minute at a time, and flipping
      // a working channel to degraded over a transient error would stop a campaign that is
      // fine. A send that really cannot go still fails with the provider's own words.
    }
  }

  return { healthy: reasons.length === 0, reasons };
}

/**
 * Writes the verdict onto the channel, and returns it.
 *
 * Called after anything that could change the answer — a domain verifying on the tick, a
 * mailbox being connected or removed — because the send path reads `channel.status` and
 * must not have to work this out for itself on every message.
 *
 * A channel a person paused stays paused. Disabling is a decision, and recomputing health
 * is not a reason to overturn one.
 */
export async function refreshChannelHealth(orgId: string, channelId: string): Promise<ChannelHealth> {
  const db = await getDb();
  const health = await evaluateChannel(orgId, channelId);

  await db.collection(C.channels).updateOne(
    { _id: new ObjectId(channelId), orgId },
    {
      $set: {
        status: health.healthy ? "healthy" : "degraded",
        ...(health.healthy ? {} : { healthReasons: health.reasons }),
      },
      ...(health.healthy ? { $unset: { healthReasons: "" } } : {}),
    },
  );

  return health;
}
