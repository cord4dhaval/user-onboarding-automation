import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Open and click tracking for HTML mail we render ourselves.
 *
 * Everything here exists to answer one question: what did a person who never replied
 * actually do? Most leads never reply, so without this the system learns nothing from the
 * majority of what it sends, and every angle looks equally dead.
 *
 * Two rules shape the design:
 *
 * 1. The redirect target is signed. An unsigned redirector on our own domain is an open
 *    redirect — anyone could hand out a link that looks like ours and lands on theirs.
 * 2. Whether a message was tracked is recorded on the action. An untracked send and an
 *    ignored one are indistinguishable otherwise, and a rollup would blame the angle for
 *    silence that was really a missing pixel.
 */

/** 1x1 transparent GIF. Small enough to inline, and every client renders it. */
export const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * The signing key is derived from the master key rather than configured separately: one
 * fewer secret to rotate, and a deployment that can send mail can already sign links.
 */
function signingKey(): Buffer {
  const b64 = process.env.MASTER_KEY_B64;
  if (!b64) throw new Error("MASTER_KEY_B64 is not set");
  return createHmac("sha256", Buffer.from(b64, "base64")).update("link-tracking-v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("hex").slice(0, 32);
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function unb64url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** c = click, o = open, u = unsubscribe. The kind is signed too, so one cannot stand in for another. */
export type TokenKind = "c" | "o" | "u";

/** Signs a link this app will have to trust later, with no session behind it. */
export function tokenFor(kind: TokenKind, id: string, target = ""): string {
  return sign(`${kind}|${id}|${target}`);
}

/** Constant-time compare, so a wrong signature cannot be found one character at a time. */
export function verify(kind: TokenKind, actionId: string, target: string, given: string): boolean {
  const expected = Buffer.from(sign(`${kind}|${actionId}|${target}`), "utf8");
  const supplied = Buffer.from(String(given ?? ""), "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export interface TrackingChoice {
  opens: boolean;
  clicks: boolean;
}

/**
 * What consent permits.
 *
 * A pixel is pure measurement and needs consent outright. Wrapping a link the person chose
 * to follow is the weaker case — the click is an action they took towards us — so it is
 * allowed under legitimate interest too. Someone who withdrew gets neither, though in
 * practice they should not be receiving mail at all.
 */
export function trackingAllowed(consentState: string | undefined): TrackingChoice {
  if (consentState === "opt_in") return { opens: true, clicks: true };
  if (consentState === "legitimate_interest") return { opens: false, clicks: true };
  return { opens: false, clicks: false };
}

export interface TrackingOptions {
  actionId: string;
  /** Public origin of this deployment. Tracking is skipped entirely without one. */
  origin: string;
  choice: TrackingChoice;
  /** Links that must keep working even if signing ever breaks — the opt-out, above all. */
  neverTrack?: string[];
}

/**
 * Rewrites outbound links through our redirector and appends the pixel.
 *
 * Operates on the rendered HTML rather than inside the renderer: the renderer is a large
 * piece of mail-client craft, and threading tracking through every block that can hold a
 * link would spread this concern across all of it.
 */
export function applyTracking(html: string, opts: TrackingOptions): { html: string; applied: TrackingChoice } {
  const applied: TrackingChoice = { opens: false, clicks: false };
  if (!opts.origin) return { html, applied };

  const origin = opts.origin.replace(/\/$/, "");
  const never = new Set(opts.neverTrack ?? []);
  let out = html;

  // A message is rendered and tracked before it is held for approval, then passed through
  // here again when it finally sends — deliberately, because approved copy is frozen and
  // re-rendered for nobody. So this has to be idempotent. Wrapping a tracking link in a
  // tracking link would send the reader through two redirects and put a URL in the mail
  // that grows every time it passes.
  const alreadyTracked = `${origin}/api/t/`;

  if (opts.choice.clicks) {
    out = out.replace(/href="([^"]*)"/g, (whole, raw: string) => {
      // The renderer escapes attributes, so an ampersand arrives as an entity. Sign the
      // real URL, then re-escape what we emit.
      const target = raw.replace(/&amp;/g, "&");
      if (!/^https?:\/\//i.test(target) || never.has(target)) return whole;
      if (target.startsWith(alreadyTracked)) {
        applied.clicks = true;
        return whole;
      }
      applied.clicks = true;
      const url = `${origin}/api/t/c/${opts.actionId}?u=${b64url(target)}&s=${sign(`c|${opts.actionId}|${target}`)}`;
      return `href="${url.replace(/&/g, "&amp;")}"`;
    });
  }

  if (opts.choice.opens) {
    if (out.includes(`${alreadyTracked}o/`)) return { html: out, applied: { ...applied, opens: true } };
    const url = `${origin}/api/t/o/${opts.actionId}?s=${sign(`o|${opts.actionId}|`)}`;
    const pixel = `<img src="${url.replace(/&/g, "&amp;")}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
    if (out.includes("</body>")) {
      out = out.replace("</body>", `${pixel}</body>`);
      applied.opens = true;
    }
  }

  return { html: out, applied };
}
