import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { sealSecret } from "@/crypto/envelope.js";
import { exchangeCode, type AuthServerMetadata } from "@/mcp/oauth.js";
import { requireSession } from "../../../tenant";

/**
 * Completes the authorization-code exchange and stores the tokens encrypted.
 *
 * The PKCE verifier and state were written to the connection when the flow started; both
 * are cleared here so a replayed callback cannot mint a second token.
 */
export async function GET(request: NextRequest) {
  const { orgId: ORG_ID } = await requireSession();
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const oauthError = params.get("error");

  if (oauthError) {
    return NextResponse.redirect(new URL(`/products?oauth_error=${encodeURIComponent(oauthError)}`, request.url));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL("/products?oauth_error=missing_code", request.url));
  }

  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ orgId: ORG_ID, "oauth.state": state });
  if (!connection) {
    return NextResponse.redirect(new URL("/products?oauth_error=unknown_state", request.url));
  }

  const oauth = connection.oauth as {
    metadata: AuthServerMetadata;
    clientId: string;
    clientSecret?: string;
    verifier: string;
    redirectUri: string;
  };

  try {
    const tokens = await exchangeCode({
      metadata: oauth.metadata,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      redirectUri: oauth.redirectUri,
      verifier: oauth.verifier,
      code,
      resource: String(connection.serverUrl),
    });

    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;

    await db.collection(C.credentials).updateOne(
      { orgId: ORG_ID, connectionId: String(connection._id) },
      {
        $set: {
          orgId: ORG_ID,
          connectionId: String(connection._id),
          authType: "mcp_oauth",
          ...sealSecret(tokens.access_token),
          refreshTokenEnc: tokens.refresh_token ? sealSecret(tokens.refresh_token) : undefined,
          expiresAt,
          // Refresh ahead of expiry rather than on failure, so a send never waits on it.
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
          status: "verifying",
          scopes: tokens.scope ? tokens.scope.split(" ") : [],
          lastVerifiedAt: new Date(),
        },
        // The verifier and state are single-use.
        $unset: { "oauth.verifier": "", "oauth.state": "" },
      },
    );

    return NextResponse.redirect(
      new URL(`/products/${String(connection.productId)}/connections/${String(connection._id)}`, request.url),
    );
  } catch (err) {
    await db
      .collection(C.connections)
      .updateOne({ _id: connection._id }, { $set: { status: "degraded" } });
    const message = err instanceof Error ? err.message : "exchange_failed";
    return NextResponse.redirect(
      new URL(
        `/products/${String(connection.productId)}/connections?oauth_error=${encodeURIComponent(message)}`,
        request.url,
      ),
    );
  }
}
