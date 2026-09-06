import type { Document } from "mongodb";
import type { MergeVars } from "./compose.js";
import { greetingName } from "./names.js";
import { unsubscribeUrl } from "./unsubscribe.js";

/**
 * The merge variables a message is rendered with.
 *
 * Shared rather than rebuilt per caller: the send path and the review screen have to agree
 * on every one of these, or a reviewer approves "Hi Kiran" and the recipient reads "Hi
 * there" — a difference nobody would think to look for, because both screens look right on
 * their own.
 */
/**
 * This app's own origin, with no trailing slash — where a tracked link or an unsubscribe
 * comes back to.
 *
 * A function rather than a bare `origin` binding on purpose: `origin` is a DOM global, so
 * a reference to one that does not exist here type-checks cleanly and then throws
 * "origin is not defined" at send time, one message at a time, in production.
 */
export function appOrigin(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ?? "";
}

export function mergeVarsFor(person: Document, product: Document | null): MergeVars {
  const config = (product?.config ?? {}) as { trialLinkTemplate?: string; website?: string };
  const site = (config.website ?? "https://example.com").replace(/\/$/, "");
  const personId = String(person._id);
  const name = String(person.name ?? "");

  const origin = appOrigin();
  return {
    first_name: greetingName(name),
    full_name: name,
    company: String(person.companyDomain ?? "").split(".")[0] || "your team",
    person_id: personId,
    trial_link: (config.trialLinkTemplate ?? `${site}/start?p={{person_id}}`).replace("{{person_id}}", personId),
    // Points at this app, not the product's website. The marketing site has no access
    // to this database, so a link there is a door painted on a wall: the reader
    // believes they have left and the mail keeps coming. Falls back to the old form
    // only when APP_URL is unset, where nothing here could work anyway.
    opt_out_url: origin ? unsubscribeUrl(origin, personId) : `${site}/unsubscribe?p=${personId}`,
  };
}
