import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { openSecret, sealSecret, type SealedSecret } from "./envelope.js";
import { refreshToken, type AuthServerMetadata } from "../mcp/oauth.js";
import { googleClient, refreshGoogleToken } from "../auth/google.js";

/**
 * The only path to a plaintext secret. Callers are engine-side adapters running in a
 * worker or a server route — never an MCP tool response, never a log line, never anything
 * that can reach a model's context.
 *
 * Every resolution writes an audit row, so a later question of "which process touched
 * which key, when" has an answer.
 */
export async function resolveSecret(orgId: string, connectionId: string, actor: string): Promise<string> {
  const db = await getDb();
  const doc = await db.collection(C.credentials).findOne({
    orgId,
    connectionId,
    status: { $in: ["verified", "degraded"] },
  });
  if (!doc) throw new Error(`no usable credential for connection ${connectionId}`);

  const refreshed = await refreshIfExpiring(orgId, connectionId, doc);
  if (refreshed) return refreshed;

  await db.collection(C.audit).insertOne({
    _id: new ObjectId(),
    orgId,
    actorType: "engine",
    actorId: actor,
    action: "credential.resolve",
    target: connectionId,
    at: new Date(),
  });

  await db.collection(C.credentials).updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } });
  return openSecret(doc as unknown as SealedSecret);
}

/**
 * Refreshes an OAuth access token shortly before it expires so a send never waits on it.
 * Returns the new token, or null when nothing needed refreshing.
 */
async function refreshIfExpiring(
  orgId: string,
  connectionId: string,
  doc: Record<string, unknown>,
): Promise<string | null> {
  const refreshAfter = doc.refreshAfter as Date | undefined;
  const sealedRefresh = doc.refreshTokenEnc as SealedSecret | undefined;
  if (!refreshAfter || !sealedRefresh || new Date(refreshAfter) > new Date()) return null;

  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection) return null;

  const oauth = connection.oauth as
    | { metadata: AuthServerMetadata; clientId: string; clientSecret?: string }
    | undefined;

  // Two OAuth shapes reach this function. An MCP server renews against whatever
  // authorization server it discovered; a provider mailbox renews against a fixed endpoint
  // with this deployment's own client. Branching here rather than in two copies of the
  // function keeps one audit path and one place where a dead refresh downgrades a channel.
  const isProvider = connection.authType === "oauth2";
  if (!isProvider && (!oauth?.metadata || !connection.serverUrl)) return null;
  if (isProvider && connection.provider !== "google") return null;

  try {
    const tokens = isProvider
      ? await refreshGoogleToken({
          client: googleClient(),
          refreshToken: openSecret(sealedRefresh),
        })
      : await refreshToken({
          metadata: oauth!.metadata,
          clientId: oauth!.clientId,
          clientSecret: oauth!.clientSecret,
          refreshToken: openSecret(sealedRefresh),
          resource: String(connection.serverUrl),
        });
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;

    await db.collection(C.credentials).updateOne(
      { orgId, connectionId },
      {
        $set: {
          ...sealSecret(tokens.access_token),
          ...(tokens.refresh_token ? { refreshTokenEnc: sealSecret(tokens.refresh_token) } : {}),
          expiresAt,
          refreshAfter: expiresAt ? new Date(expiresAt.getTime() - 120_000) : undefined,
          status: "verified",
        },
      },
    );
    return tokens.access_token;
  } catch {
    // Escalate rather than fail silently: the channel goes degraded and drops out of the
    // planner's candidate set until someone reconnects it.
    await db.collection(C.credentials).updateOne({ orgId, connectionId }, { $set: { status: "expired" } });
    await db
      .collection(C.connections)
      .updateOne({ _id: new ObjectId(connectionId) }, { $set: { status: "degraded" } });
    throw new Error(
      isProvider
        ? "Google refused the refresh token — reconnect this mailbox"
        : "OAuth token expired and refresh failed — reconnect this server",
    );
  }
}

/** What an MCP tool is allowed to see about a connection. Deliberately excludes the secret. */
export interface PublicConnectionView {
  connectionId: string;
  provider: string;
  status: string;
  capabilities?: Record<string, unknown>;
}
