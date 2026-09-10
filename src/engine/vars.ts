import type { Document } from "mongodb";
import type { MergeVars } from "./compose.js";
import { greetingName } from "./names.js";
import { unsubscribeUrl } from "./unsubscribe.js";
import { tokenFor } from "./tracking.js";

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

/**
 * What to call the company in a sentence.
 *
 * A stored name wins. Otherwise the domain, which arrives in every shape a lead form
 * allows — "www.whitelabelmedia.in", "http://crystalsign.in/", "wwwpioneercars.in" — and
 * used to be split on the first dot, which put "www" into subject lines. Strip the scheme
 * and the www, drop the public suffix (including two-part ones like co.in), and
 * capitalise what is left. "Whitelabelmedia" is not perfect, but it is the company.
 */
export function companyNameFrom(person: Document): string {
  const stored = String(person.company ?? person.companyName ?? "").trim();
  if (stored) return stored;
  let host = String(person.companyDomain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\.?/, "");
  if (!host) return "your team";
  const labels = host.split(".").filter(Boolean);
  const twoPart = new Set(["co", "com", "net", "org", "ac", "gov", "edu"]);
  let name = labels[0] ?? "";
  if (labels.length >= 3 && twoPart.has(labels[labels.length - 2] ?? "")) name = labels[labels.length - 3] ?? name;
  else if (labels.length >= 2) name = labels[labels.length - 2] ?? name;
  name = name.replace(/[-_]+/g, " ").trim();
  if (!name || name.length < 2) return "your team";
  return name.charAt(0).toUpperCase() + name.slice(1);
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
    company: companyNameFrom(person),
    person_id: personId,
    // The template may carry the visit token too, so a page on the customer's site can
    // report the person back to /api/e/<event>; both merge fields are filled here.
    trial_link: (config.trialLinkTemplate ?? `${site}/register?p={{person_id}}`)
      .replace("{{person_id}}", personId)
      .replace("{{visit_token}}", tokenFor("e", personId)),
    // Points at this app, not the product's website. The marketing site has no access
    // to this database, so a link there is a door painted on a wall: the reader
    // believes they have left and the mail keeps coming. Falls back to the old form
    // only when APP_URL is unset, where nothing here could work anyway.
    opt_out_url: origin ? unsubscribeUrl(origin, personId) : `${site}/unsubscribe?p=${personId}`,
    // Carried into links that leave for the customer's own site, so a page there can tell
    // us this person reached it: POST {APP_URL}/api/e/<event>?p=<person_id>&s=<visit_token>.
    // Signed, because that endpoint can finish a campaign and a bare person id in a URL is
    // a guess away from finishing somebody else's.
    visit_token: tokenFor("e", personId),
  };
}
