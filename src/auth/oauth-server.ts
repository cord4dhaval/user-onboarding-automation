import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * We are the authorization server for our own MCP endpoint.
 *
 * This is what makes the product multi-tenant in Claude: each user authorises their own
 * connector, and the token they receive is bound to their organisation. A shared static
 * token could never do that — every connector would see every tenant's leads.
 *
 * Tokens are stored hashed. A leaked database yields nothing usable.
 */

const ACCESS_TTL_SEC = 3600;
const CODE_TTL_SEC = 300;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

export async function registerClient(args: {
  clientName: string;
  redirectUris: string[];
}): Promise<RegisteredClient> {
  const db = await getDb();
  if (args.redirectUris.length === 0) throw new Error("at least one redirect_uri is required");

  const clientId = `ce_${randomBytes(16).toString("hex")}`;
  await db.collection(C.oauthClients).insertOne({
    _id: new ObjectId(),
    clientId,
    clientName: args.clientName,
    redirectUris: args.redirectUris,
    createdAt: new Date(),
  });
  return { client_id: clientId, client_name: args.clientName, redirect_uris: args.redirectUris };
}

export async function getClient(clientId: string) {
  const db = await getDb();
  return db.collection(C.oauthClients).findOne({ clientId });
}

/** Issued after the user consents. Single use, short lived, bound to the PKCE challenge. */
export async function issueCode(args: {
  clientId: string;
  userId: string;
  orgId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
}): Promise<string> {
  const db = await getDb();
  const code = newToken();
  await db.collection(C.oauthCodes).insertOne({
    _id: new ObjectId(),
    codeHash: hashToken(code),
    ...args,
    expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
    createdAt: new Date(),
  });
  return code;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

async function mintTokens(args: {
  clientId: string;
  userId: string;
  orgId: string;
  scope: string;
}): Promise<TokenSet> {
  const db = await getDb();
  const accessToken = newToken();
  const refreshToken = newToken();

  await db.collection(C.oauthTokens).insertOne({
    _id: new ObjectId(),
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    ...args,
    expiresAt: new Date(Date.now() + ACCESS_TTL_SEC * 1000),
    revokedAt: null,
    createdAt: new Date(),
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    scope: args.scope,
  };
}

export async function exchangeCode(args: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  const db = await getDb();
  // Consumed on read, so a replayed code finds nothing.
  const record = await db.collection(C.oauthCodes).findOneAndDelete({ codeHash: hashToken(args.code) });
  if (!record) throw new Error("invalid_grant");
  if (new Date(record.expiresAt as Date) < new Date()) throw new Error("invalid_grant");
  if (record.clientId !== args.clientId) throw new Error("invalid_grant");
  if (record.redirectUri !== args.redirectUri) throw new Error("invalid_grant");

  const challenge = createHash("sha256").update(args.codeVerifier).digest("base64url");
  if (challenge !== record.codeChallenge) throw new Error("invalid_grant");

  return mintTokens({
    clientId: String(record.clientId),
    userId: String(record.userId),
    orgId: String(record.orgId),
    scope: String(record.scope),
  });
}

export async function refresh(args: { refreshToken: string; clientId: string }): Promise<TokenSet> {
  const db = await getDb();
  const record = await db
    .collection(C.oauthTokens)
    .findOne({ refreshTokenHash: hashToken(args.refreshToken), revokedAt: null });
  if (!record || record.clientId !== args.clientId) throw new Error("invalid_grant");

  // Rotate: the old pair is revoked as the new one is issued.
  await db.collection(C.oauthTokens).updateOne({ _id: record._id }, { $set: { revokedAt: new Date() } });
  return mintTokens({
    clientId: String(record.clientId),
    userId: String(record.userId),
    orgId: String(record.orgId),
    scope: String(record.scope),
  });
}

export interface McpCaller {
  userId: string;
  orgId: string;
  scope: string;
}

/** Resolves a bearer token to the organisation it may act on. */
export async function resolveAccessToken(token: string): Promise<McpCaller | null> {
  const db = await getDb();
  const record = await db
    .collection(C.oauthTokens)
    .findOne({ accessTokenHash: hashToken(token), revokedAt: null });
  if (!record) return null;
  if (new Date(record.expiresAt as Date) < new Date()) return null;
  return { userId: String(record.userId), orgId: String(record.orgId), scope: String(record.scope) };
}
