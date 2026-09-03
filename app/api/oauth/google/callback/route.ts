import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { sealSecret } from "@/crypto/envelope.js";
import {
  exchangeGoogleCode,
  googleClient,
  googleProfile,
  grantedCapabilities,
  sendAsAliases,
} from "@/auth/google.js";
import { requireSession } from "../../../../tenant";

/**
 * Completes a Gmail connect and leaves behind a channel that can actually send.
 *
 * Deliberately separate from the MCP callback. That one negotiates with whatever
 * authorization server a server URL happens to advertise; this one talks to a single
 * provider whose quirks — refresh tokens only on fresh consent, scopes that may come back
 * narrower than they were asked for — belong in one place rather than behind a branch in
 * shared code.
 */
export async function GET(request: NextRequest) {
  const { orgId } = await requireSession();
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const denied = params.get("error");

  const db = await getDb();
  const connection = state
    ? await db.collection(C.connections).findOne({ orgId, authType: "oauth2", "oauth.state": state })
    : null;

  const back = (query: string) =>
    NextResponse.redirect(
      new URL(
        connection ? `/products/${String(connection.productId)}/channels?${query}` : `/products?${query}`,
        request.url,
      ),
    );

  // Someone clicking "cancel" on the consent screen is not an error worth keeping a
  // half-built connection around for.
  if (denied) {
    if (connection) await db.collection(C.connections).deleteOne({ _id: connection._id });
    return back(`oauth_error=${encodeURIComponent(denied)}`);
  }
  if (!code || !state) return back("oauth_error=missing_code");
  if (!connection) return back("oauth_error=unknown_state");

  const oauth = connection.oauth as { verifier: string; redirectUri: string; scopes: string[] };

  try {
    const tokens = await exchangeGoogleCode({
      client: googleClient(),
      code,
      redirectUri: oauth.redirectUri,
      verifier: oauth.verifier,
    });

    // A consent screen lets someone untick individual scopes, so what was asked for and
    // what was granted are different facts. Everything downstream reads the granted list.
    const scopes = tokens.scope ? tokens.scope.split(" ") : oauth.scopes;
    const caps = grantedCapabilities(scopes);
    if (!caps.send) {
      await db.collection(C.connections).deleteOne({ _id: connection._id });
      return back("oauth_error=send_permission_declined");
    }

    const profile = await googleProfile(tokens.access_token);
    const aliases = caps.manage ? await sendAsAliases(tokens.access_token) : [];

    // No refresh token means this account had already consented and Google saw no reason to
    // mint a second one. The connection would work for an hour and then die, so it is
    // refused now, with the fix — revoke at myaccount.google.com — rather than at 2am.
    if (!tokens.refresh_token) {
      await db.collection(C.connections).deleteOne({ _id: connection._id });
      return back("oauth_error=no_refresh_token");
    }

    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;

    await db.collection(C.credentials).updateOne(
      { orgId, connectionId: String(connection._id) },
      {
        $set: {
          orgId,
          connectionId: String(connection._id),
          authType: "oauth2",
          ...sealSecret(tokens.access_token),
          refreshTokenEnc: sealSecret(tokens.refresh_token),
          expiresAt,
          refreshAfter: expiresAt ? new Date(expiresAt.getTime() - 120_000) : undefined,
          status: "verified",
        },
      },
      { upsert: true },
    );

    await db.collection(C.connections).updateOne(
      { _id: connection._id },
      {
        $set: {
          status: "healthy",
          scopes,
          accountEmail: profile.email,
          accountName: profile.name,
          sendAs: aliases,
          grants: caps,
          lastVerifiedAt: new Date(),
        },
        $unset: { "oauth.verifier": "", "oauth.state": "" },
      },
    );

    await ensureChannel(orgId, connection, profile.email, caps);

    return back(`connected=${encodeURIComponent(profile.email)}`);
  } catch (err) {
    await db.collection(C.connections).updateOne({ _id: connection._id }, { $set: { status: "degraded" } });
    return back(`oauth_error=${encodeURIComponent(err instanceof Error ? err.message : "exchange_failed")}`);
  }
}

/**
 * One connect, one working channel. Making the customer fill a second form after they have
 * already authorised the mailbox is how a connected account sits there sending nothing.
 *
 * Capabilities are written from the scopes actually granted, not from what Gmail can do in
 * principle: a mailbox connected send-only reports no inbound replies, and the planner then
 * stops choosing angles whose whole point is starting a conversation it cannot hear.
 */
async function ensureChannel(
  orgId: string,
  connection: Record<string, unknown>,
  email: string,
  caps: { send: boolean; read: boolean; manage: boolean },
) {
  const db = await getDb();
  const existing = await db
    .collection(C.channels)
    .findOne({ orgId, connectionId: String(connection._id) });
  if (existing) {
    await db.collection(C.channels).updateOne(
      { _id: existing._id },
      { $set: { status: "healthy", from: email, "capabilities.inboundReplies": caps.read } },
    );
    return;
  }

  await db.collection(C.channels).insertOne({
    _id: new ObjectId(),
    orgId,
    productId: String(connection.productId),
    connectionId: String(connection._id),
    key: "email",
    kind: "native",
    from: email,
    capabilities: {
      send: true,
      html: true,
      htmlSource: "human",
      attachments: true,
      richTypes: [],
      // Gmail reports neither. Both come from our own pixel and redirector, which is why
      // they are true here — the channel can carry tracked HTML even though the provider
      // itself never says a word about what happened to the message.
      trackingOpens: true,
      trackingClicks: true,
      // No webhook exists. A bounce arrives as mail, and the inbound poller finds it, which
      // needs read scope — so this is only honest when read scope was granted.
      bounceWebhook: false,
      inboundReplies: caps.read,
      consentRequired: false,
      fromDomain: "caller_controlled",
      asyncDelivery: false,
    },
    /**
     * Below Google's own ceiling on purpose. A consumer account cuts off at 500 recipients
     * a day and a Workspace one at 2,000, and hitting either means every later send that
     * day fails; 200 with a warmup leaves room for the mailbox's ordinary human traffic.
     * Both numbers are editable in the channel's settings.
     */
    governor: {
      dailyCap: 200,
      perMinute: 10,
      perHour: 60,
      warmupDay: 1,
      sentToday: 0,
      windowStartedAt: new Date(),
    },
    policy: { audience: ["cold", "warm_lead", "existing_user"] },
    status: "healthy",
    enabled: true,
  });
}
