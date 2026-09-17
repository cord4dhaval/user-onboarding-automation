/**
 * A LinkedIn session is a set of browser cookies acting for one member. This file turns the
 * stored cookies into the request headers Voyager expects, and classifies every response so
 * the engine can tell a dead session from a rate limit from a real error.
 *
 * The session is the user's own, captured from their browser (method A: paste or extension).
 * We never drive a login here, so there is no password and no checkpoint to solve — the
 * human already did that in their browser.
 */

import { RetryableSendError } from "../types.js";
import { CLIENT_VERSION } from "./endpoints.js";

/** What we store, sealed, per connected account. Exactly what a browser hands over. */
export interface LinkedInSession {
  /** The auth cookie. The one that matters. */
  li_at: string;
  /** The CSRF cookie, value like `ajax:1234567890`. LinkedIn's SPA echoes it as a header. */
  jsessionid: string;
  /**
   * The user agent of the browser the cookies came from. Sending a different one is the
   * fastest way to get the session invalidated, so it is captured with the cookies and
   * replayed on every call.
   */
  userAgent: string;
}

/**
 * Thrown when the session itself is the problem, not the request. The broker marks the
 * credential accordingly and the channel health check turns the row red with this reason.
 */
export class SessionError extends Error {
  constructor(
    readonly kind: "expired" | "restricted" | "challenge",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/** JSESSIONID arrives from the browser wrapped in quotes; the csrf-token header is unquoted. */
function csrfToken(jsessionid: string): string {
  return jsessionid.replace(/^"|"$/g, "");
}

export function sessionHeaders(session: LinkedInSession, accept = "application/vnd.linkedin.normalized+json+2.1"): Record<string, string> {
  const jsession = session.jsessionid.startsWith('"') ? session.jsessionid : `"${csrfToken(session.jsessionid)}"`;
  return {
    cookie: `li_at=${session.li_at}; JSESSIONID=${jsession}`,
    "csrf-token": csrfToken(session.jsessionid),
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    // LinkedIn's SPA stamps this on every call; write actions can be refused without it.
    "x-li-track": JSON.stringify({
      clientVersion: CLIENT_VERSION,
      mpVersion: CLIENT_VERSION,
      osName: "web",
      timezoneOffset: 0,
      timezone: "UTC",
      deviceFormFactor: "DESKTOP",
      mpName: "voyager-web",
    }),
    accept,
    "user-agent": session.userAgent,
  };
}

/**
 * One request against Voyager, with the session applied and the response classified.
 *
 * Classification is the whole point. A 401 or a redirect to the login/checkpoint pages means
 * the session is gone and the user must reconnect — never a retry. A 429 or a 999 means
 * LinkedIn is throttling or has flagged the account, which is back-pressure, so it becomes a
 * RetryableSendError the send loop already knows how to defer. Everything else is a genuine
 * error carrying LinkedIn's own status.
 */
export async function voyagerFetch(
  session: LinkedInSession,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...sessionHeaders(session), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // A network blip is back-pressure, not a failed send.
    throw new RetryableSendError(`LinkedIn unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A Voyager API call never legitimately redirects. Any 3xx means the session was not
  // accepted: LinkedIn bounces an unauthenticated or expired call to its auth wall. A
  // checkpoint (2FA / captcha) is the one worth naming apart, because the fix is different —
  // the user solves it in their browser rather than pasting a fresh cookie.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    if (/checkpoint|challenge/.test(location)) {
      throw new SessionError("challenge", "LinkedIn wants a security check; solve it in the browser, then reconnect");
    }
    throw new SessionError("expired", "the LinkedIn session was not accepted; reconnect the account");
  }

  if (res.status === 401) {
    throw new SessionError("expired", "the LinkedIn session has ended; reconnect the account");
  }
  // 999 is LinkedIn's own "request denied" bot block; 403 on a call that worked before is the
  // same signal. Both mean the account is being rate-limited or restricted, so back off.
  if (res.status === 999) {
    throw new SessionError("restricted", "LinkedIn is blocking this account's requests (999)");
  }
  if (res.status === 429) {
    throw new RetryableSendError("LinkedIn is throttling this account (429)", 900);
  }

  return res;
}

/** Read a Voyager JSON body, or throw its status. Callers that need the raw Response skip this. */
export async function voyagerJson<T = unknown>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LinkedIn ${what} answered HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  return res.json() as Promise<T>;
}
