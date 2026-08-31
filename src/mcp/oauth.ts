import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.1 for remote MCP servers: metadata discovery, dynamic client registration,
 * PKCE, and token exchange.
 *
 * This is the path a customer should take — they authorise on the provider's own consent
 * screen and we never handle a password. A pasted bearer token remains supported for
 * servers that do not implement OAuth.
 */

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export const randomState = () => randomBytes(16).toString("base64url");

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Follows the MCP authorization flow: the protected-resource document names its
 * authorization servers; older servers publish authorization-server metadata directly.
 * Returns null when the server does not speak OAuth, which is a normal outcome — the
 * caller then falls back to asking for a token.
 */
export async function discoverAuthServer(serverUrl: string): Promise<AuthServerMetadata | null> {
  const origin = new URL(serverUrl).origin;

  const resource = await fetchJson<{ authorization_servers?: string[] }>(
    `${origin}/.well-known/oauth-protected-resource`,
  );
  const issuer = resource?.authorization_servers?.[0];
  if (issuer) {
    const metadata =
      (await fetchJson<AuthServerMetadata>(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)) ??
      (await fetchJson<AuthServerMetadata>(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`));
    if (metadata?.authorization_endpoint) return metadata;
  }

  return (
    (await fetchJson<AuthServerMetadata>(`${origin}/.well-known/oauth-authorization-server`)) ??
    (await fetchJson<AuthServerMetadata>(`${origin}/.well-known/openid-configuration`))
  );
}

/** Registers this deployment as a client. Servers without DCR need a pre-issued client id. */
export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  clientName: string,
): Promise<{ client_id: string; client_secret?: string } | null> {
  if (!metadata.registration_endpoint) return null;
  try {
    const res = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { client_id: string; client_secret?: string };
  } catch {
    return null;
  }
}

export function buildAuthorizeUrl(args: {
  metadata: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes?: string[];
  /** RFC 8707 — binds the issued token to this specific MCP server. */
  resource: string;
}): string {
  const url = new URL(args.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  url.searchParams.set("resource", args.resource);
  // Least privilege: ask only for what the adapters actually call.
  const scopes = args.scopes ?? args.metadata.scopes_supported;
  if (scopes?.length) url.searchParams.set("scope", scopes.join(" "));
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCode(args: {
  metadata: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  verifier: string;
  code: string;
  resource: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
    resource: args.resource,
  });
  if (args.clientSecret) body.set("client_secret", args.clientSecret);

  const res = await fetch(args.metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  // Token endpoints echo request detail in error bodies, so surface status only.
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshToken(args: {
  metadata: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    resource: args.resource,
  });
  if (args.clientSecret) body.set("client_secret", args.clientSecret);

  const res = await fetch(args.metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  return (await res.json()) as TokenResponse;
}
