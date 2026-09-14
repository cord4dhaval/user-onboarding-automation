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
