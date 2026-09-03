import { createPkce, randomState, type PkcePair } from "../mcp/oauth.js";

/**
 * Google OAuth for the email channel.
 *
 * This is the first-party replacement for two weaker paths: an SMTP password typed into a
 * form, and a borrowed access token handed out by somebody else's MCP tool. Here the
 * customer authorises their own mailbox on Google's consent screen, we hold a refresh
 * token, and nothing about the arrangement depends on a third party staying online.
 *
 * Scopes are grouped by what Google charges for them, not by what we happen to want:
 *
 *   send      gmail.send is a *sensitive* scope. It needs OAuth verification — a brand
 *             review, a few weeks — and nothing more.
 *   read      gmail.readonly and gmail.modify are *restricted* scopes. They additionally
 *             need a CASA security assessment, repeated annually and paid for. This is the
 *             only way to see replies and bounces from inside the mailbox.
 *   manage    settings.basic is restricted too. It buys the send-as alias list, so a
 *             channel can send as an address the mailbox owns rather than only as itself.
 *
 * The grouping exists so a deployment can ship send-only to production the moment brand
 * verification clears, and turn the restricted tiers on later without a code change.
 */

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_SCOPE_TIERS = {
  /** Who connected. Neither sensitive nor restricted, so it costs nothing to ask for. */
  identity: ["openid", "email", "profile"],
  /** Sending. Sensitive: verification, no audit. */
  send: ["https://www.googleapis.com/auth/gmail.send"],
  /**
   * Reading. Restricted: CASA.
   *
   * modify is a superset of readonly, and asking for both only lengthens the consent
   * screen. modify is the one requested because reply handling wants to label a thread as
   * seen — reading without being able to mark anything means re-reading the same window
   * forever and hoping the dedupe holds.
   */
  read: ["https://www.googleapis.com/auth/gmail.modify"],
  /** Aliases and vacation settings. Restricted: CASA, same assessment as read. */
  manage: ["https://www.googleapis.com/auth/gmail.settings.basic"],
} as const;

export type ScopeTier = keyof typeof GOOGLE_SCOPE_TIERS;

/**
 * Which tiers this deployment asks for. Defaults to everything, because a mailbox
 * connected without read scope can send but can never learn — and reconnecting a customer
 * later to widen scope is a consent screen they have every right to refuse.
 *
 * Set GOOGLE_SCOPE_TIERS=identity,send to run send-only while CASA is outstanding.
 */
export function configuredScopes(): string[] {
  const raw = (process.env.GOOGLE_SCOPE_TIERS ?? "identity,send,read,manage")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean) as ScopeTier[];
  const tiers = raw.filter((t) => t in GOOGLE_SCOPE_TIERS);
  // An unreadable setting must not silently produce a mailbox that cannot send.
  const chosen = tiers.length > 0 ? tiers : (["identity", "send"] as ScopeTier[]);
  return [...new Set(chosen.flatMap((t) => [...GOOGLE_SCOPE_TIERS[t]]))];
}

/** What a stored scope list actually permits. Read by the channel's capability flags. */
export function grantedCapabilities(scopes: string[]): {
  send: boolean;
  read: boolean;
  manage: boolean;
} {
  const has = (s: string) => scopes.includes(s) || scopes.includes("https://mail.google.com/");
  return {
    send: has("https://www.googleapis.com/auth/gmail.send"),
    read:
      has("https://www.googleapis.com/auth/gmail.modify") ||
      has("https://www.googleapis.com/auth/gmail.readonly"),
    manage: has("https://www.googleapis.com/auth/gmail.settings.basic"),
  };
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Google issues no dynamic client registration, so unlike the MCP flow there is exactly
 * one client and it comes from the environment. Failing loudly here beats redirecting a
 * customer to a consent screen that renders "invalid_client".
 */
export function googleClient(): GoogleClient {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set — see docs/google-oauth-setup.md",
    );
  }
  return { clientId, clientSecret };
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export function startGoogleFlow(): PkcePair & { state: string } {
  return { ...createPkce(), state: randomState() };
}

export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
  /** Pre-fills the account chooser when we already know which mailbox is being connected. */
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Without both of these Google returns an access token and no refresh token, and the
  // connection dies silently an hour later with nothing to renew it. prompt=consent is
  // required because Google only re-issues a refresh token on a fresh consent — a second
  // connect of an already-approved account would otherwise come back unrenewable.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Google's error body names the cause precisely (invalid_grant, redirect_uri_mismatch);
    // swallowing it turns a five-minute console fix into an afternoon.
    throw new Error(`google token endpoint ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as GoogleTokens;
}

export async function exchangeGoogleCode(input: {
  client: GoogleClient;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<GoogleTokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
}

export async function refreshGoogleToken(input: {
  client: GoogleClient;
  refreshToken: string;
}): Promise<GoogleTokens> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
  });
}

/**
 * The address the tokens belong to. Asked for rather than inferred: a customer who picks
 * the wrong account in the chooser should end up with a channel labelled by the mailbox
 * they actually authorised, not by the one they meant to.
 */
export async function googleProfile(accessToken: string): Promise<{ email: string; name?: string }> {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`google userinfo ${res.status}`);
  const body = (await res.json()) as { email?: string; name?: string };
  if (!body.email) throw new Error("google userinfo returned no email");
  return { email: body.email, name: body.name };
}

/**
 * Send-as aliases the mailbox owns, so the From address can be one the customer already
 * uses. Returns an empty list without the manage scope rather than throwing — a channel
 * that can only send as itself is a working channel.
 */
export async function sendAsAliases(accessToken: string): Promise<string[]> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { sendAs?: Array<{ sendAsEmail?: string; verificationStatus?: string }> };
  return (body.sendAs ?? [])
    .filter((a) => a.sendAsEmail && a.verificationStatus !== "pending")
    .map((a) => String(a.sendAsEmail));
}
