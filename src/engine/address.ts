import type { Document } from "mongodb";

/**
 * Where a person is reached on a given channel.
 *
 * The send path used to read `primaryEmail` and hand it to whichever adapter the channel
 * pointed at. That worked while every channel was email and silently addressed a WhatsApp
 * message to an inbox the moment one was not: the provider rejected it, the action failed,
 * and nothing on the row said why. A person carries identities of several kinds; which one
 * addresses a message is a property of the channel, so it is asked here rather than assumed.
 */
const IDENTITY_KIND: Record<string, "email" | "phone" | "linkedin" | "product_uid"> = {
  email: "email",
  whatsapp: "phone",
  sms: "phone",
  voice: "phone",
  linkedin: "linkedin",
  in_app: "product_uid",
  push: "product_uid",
};

/** The identity kind a channel addresses. Unknown keys fall back to email, as before. */
export function identityKindFor(channelKey: string): string {
  return IDENTITY_KIND[channelKey] ?? "email";
}

/**
 * One identity of a given kind, verified first, or "" when the person has none.
 *
 * Separate from `addressFor` because the two questions differ: the send path asks what
 * addresses this channel, while a payload being filled in for a provider asks for a phone
 * number regardless of which channel is carrying it.
 */
export function identityValue(person: Document, kind: string): string {
  const identities = (person.identities ?? []) as { kind: string; value: string; verified?: boolean }[];
  const matching = identities.filter((i) => i.kind === kind && i.value);
  // A verified identity beats an unverified one; order within each group is arrival order.
  return String(matching.find((i) => i.verified)?.value ?? matching[0]?.value ?? "");
}

/**
 * The address to send to, or "" when this person cannot be reached on this channel at all.
 *
 * Empty is a real answer and the caller is expected to record it: a lead with no phone is
 * not a failed send, it is a person the WhatsApp channel was never able to carry, and the
 * two read differently on the row.
 */
export function addressFor(person: Document, channelKey: string): string {
  const kind = identityKindFor(channelKey);

  // primaryEmail is the chosen one of possibly several, so it wins over the identity list
  // for email. Every other kind has no such field and is read from identities directly.
  if (kind === "email" && person.primaryEmail) return String(person.primaryEmail);
  return identityValue(person, kind);
}

/** Digits only, which is the form most WhatsApp and SMS providers accept. */
export function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/**
 * The vanity slug from a LinkedIn profile URL — the part after `/in/` — which is what we
 * store as the person's `linkedin` identity and later resolve to a provider id.
 *
 * Accepts a full URL, a bare `/in/slug`, or an already-bare slug, and tolerates a trailing
 * slash, query string or locale prefix. Returns "" for anything that isn't a personal
 * profile (a company URL, a post link), so those never masquerade as a member.
 *
 * Lower-cased: LinkedIn treats "Dhaval-Panchal" and "dhaval-panchal" as one profile, and a
 * list keyed on the profile must too, or the same person arrives twice.
 */
export function linkedinSlug(value: string): string {
  const s = value.trim();
  if (!s) return "";
  const m = s.match(/\/in\/([^/?#]+)/i);
  if (m?.[1]) return decodeURIComponent(m[1]).toLowerCase();
  // A bare token with no slashes or protocol is taken as the slug itself.
  if (!/[/:]/.test(s)) return s.toLowerCase();
  return "";
}

/**
 * International form, which voice providers require. A bare ten-digit number, or one with a
 * leading trunk zero, is read as Indian: every lead this product calls today is, and a
 * number stored as "98765 43210" would otherwise be dialled as a nine-digit foreign one.
 */
export function e164(value: string, countryCode = "91"): string {
  const digits = digitsOnly(value);
  if (!digits) return "";
  if (value.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+${countryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+${countryCode}${digits.slice(1)}`;
  return `+${digits}`;
}
