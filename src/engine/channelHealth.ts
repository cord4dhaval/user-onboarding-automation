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

  // A LinkedIn account is healthy while its browser session is still accepted. Nothing is
  // probed here — a live call on every health refresh would burn LinkedIn's request budget
  // and could itself trip a restriction — so this mirrors the credential the send path
  // maintains: a send that meets a dead or blocked session marks the credential, and the
  // row turns red with the reason to reconnect.
  if (connection.provider === "linkedin") {
    const cred = await db
      .collection(C.credentials)
      .findOne({ orgId, connectionId: String(connection._id) });
    // LinkedIn's own words first, where a send recorded them: "wants a security check" and
    // "is blocking this account" are different fixes from a session that simply ran out.
    if (connection.status === "degraded" && connection.lastError) {
      reasons.push(String(connection.lastError));
    } else if (!cred || ["expired", "revoked", "pending"].includes(String(cred.status))) {
      reasons.push("the LinkedIn session has ended — reconnect the account");
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

/** The heldReason prefix for a queue the engine held because its channel went down. */
const CHANNEL_DOWN = "channel down";

/** The heldReason for a message held because its channel went down, in the provider's words. */
export function channelDownHold(reason: string): string {
  return `${CHANNEL_DOWN} — ${reason}`;
}

/**
 * Stops a channel that the provider has stopped accepting, from inside a send.
 *
 * Without this a dead LinkedIn session looked healthy forever: every send bounced, went
 * back in the queue for a few minutes and bounced again, the channel row stayed green, and
 * nobody was asked to reconnect. Now the first bounce records LinkedIn's reason on the
 * connection, turns the row red with it, and holds everything queued on the channel. Held
 * rather than skipped, because every one of those messages is still worth sending once the
 * account is back; reconnecting releases them (releaseChannelHolds).
 *
 * `sessionEnded` also marks the stored credential expired. A 999 does not: the session may
 * be fine, and it is the account's standing that needs a person to look at it.
 */
export async function takeChannelDown(
  orgId: string,
  channelId: string,
  reason: string,
  sessionEnded: boolean,
): Promise<void> {
  const db = await getDb();
  const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId), orgId });
  if (!channel) return;
  const connectionId = String(channel.connectionId);
  const at = new Date();

  if (sessionEnded) {
    await db
      .collection(C.credentials)
      .updateOne({ orgId, connectionId }, { $set: { status: "expired", lastError: reason, lastErrorAt: at } });
  }
  await db
    .collection(C.connections)
    .updateOne({ _id: new ObjectId(connectionId) }, { $set: { status: "degraded", lastError: reason, lastErrorAt: at } });
  await refreshChannelHealth(orgId, channelId);
  // Marks the channel as down by a send rather than by setup, so anything that reaches it
  // later is held too (fireDue's blockedReason) instead of being skipped for good.
  await db.collection(C.channels).updateOne({ _id: new ObjectId(channelId), orgId }, { $set: { downReason: reason } });

  await db
    .collection(C.actions)
    .updateMany(
      { orgId, channelId, status: "queued" },
      { $set: { status: "held", heldReason: channelDownHold(reason) }, $unset: { claimedAt: "" } },
    );
}

/**
 * Puts back what takeChannelDown held, once the channel is healthy again. Only those: a
 * paused campaign's queue on the same channel stays paused.
 */
export async function releaseChannelHolds(orgId: string, channelId: string): Promise<number> {
  const db = await getDb();
  await db.collection(C.channels).updateOne({ _id: new ObjectId(channelId), orgId }, { $unset: { downReason: "" } });
  const res = await db
    .collection(C.actions)
    .updateMany(
      { orgId, channelId, status: "held", heldReason: { $regex: `^${CHANNEL_DOWN} — ` } },
      { $set: { status: "queued" }, $unset: { heldReason: "" } },
    );
  return res.modifiedCount;
}
