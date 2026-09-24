import type { ChannelKey } from "../schemas/common.js";

/**
 * The channels this product offers, as a fixed list.
 *
 * Everything here used to be typed in by whoever added the channel: a free-text provider
 * name next to a dropdown of protocol words. That produced a column reading "smtp",
 * "Gmail", "gmail smtp", "teamgrid" and "Resend, Postmark, your own service" across five
 * tenants who had all connected the same thing — so nothing could be grouped, compared or
 * reported on, and the first question anyone was asked at setup was an infrastructure
 * question they had no reason to have an opinion about.
 *
 * A fixed catalogue answers both. The ids are ours and never change, so a rollup keyed on
 * one means the same thing next quarter; and the choice on screen becomes "which channel",
 * which is a product question a customer can answer in a second.
 *
 * What is not live is still listed. A roadmap the customer can see is worth more than a
 * shorter menu: someone who needs WhatsApp finds out now, rather than after connecting
 * email and waiting for something that was never coming.
 */

export type CatalogStatus = "live" | "soon";

/**
 * How a channel is connected. A second question, asked after "which channel", and the two
 * are genuinely independent: the same SMTP transport serves email, the same HTTP one
 * serves all three, and OAuth serves whichever provider has published a consent screen.
 *
 * Ordered best first. Signing in is first because it is the only one that stores no
 * password, needs no field mapping and can be revoked by the account owner — and the last
 * three are kept because a tenant with their own relay, ESP or MCP send tool is a real
 * customer, and above a couple of thousand messages a day they are the only kind.
 */
export const TRANSPORTS = [
  { id: "oauth", label: "Sign in", blurb: "Approve the account on the provider's own screen. No password stored." },
  {
    id: "ses",
    label: "Your own domain",
    blurb: "Send as your domain through Amazon SES. Verified by DNS, no per-mailbox cap.",
  },
  { id: "mcp", label: "MCP tool", blurb: "A send tool on a server you already connected." },
  { id: "smtp", label: "SMTP", blurb: "Any mail account or relay, with a password." },
  { id: "http", label: "API endpoint", blurb: "Any provider that takes a token over HTTP." },
  { id: "key", label: "API key", blurb: "Paste the provider's API key and choose what it runs." },
  {
    id: "session",
    label: "Browser session",
    blurb: "Paste the session from a logged-in browser. Acts as that account; no password stored.",
  },
] as const;

export type TransportId = (typeof TRANSPORTS)[number]["id"];

export interface ChannelOption {
  /** Stable identifier. Written to the connection as `provider`, so it is never a typed word. */
  id: string;
  channelKey: ChannelKey;
  /** The vendor, as the picker shows it: "Gmail". */
  label: string;
  /**
   * The kind of message, as everything downstream shows it: "Email".
   *
   * Kept apart from the label because a bring-your-own channel on the same key is not
   * Gmail — labelling a Resend endpoint "Gmail" in a dropdown is how a customer ends up
   * believing they connected something they did not.
   */
  typeLabel: string;
  status: CatalogStatus;
  /** One line in the picker: what it is, not how it works. */
  blurb: string;
  /**
   * Every way this channel can be connected, best first. OAuth belongs in this list like
   * any other transport — calling it "the native way" and everything else "bring your own"
   * hid the fact that they answer the same question, and left a customer who wanted to
   * sign in with Google looking for it under a link about bringing their own setup.
   */
  transports: TransportId[];
  /** Which provider's consent screen the oauth transport opens, where it has one. */
  oauthProvider?: "google";
  /** For a soon entry: what it is waiting on. Shown so "soon" is not just a shrug. */
  waitingOn?: string;
}

export const CHANNEL_CATALOG: ChannelOption[] = [
  {
    // "google" rather than "gmail" because it is the value already written to the
    // connection and branched on by the adapter, the broker and the inbound poller. The
    // label is what people read; the id is what code matches.
    id: "google",
    channelKey: "email",
    label: "Gmail",
    typeLabel: "Email",
    status: "live",
    blurb: "Send from your own mailbox. One click, no password.",
    // "Your own domain" sits second rather than last because it is the answer for anyone
    // who has outgrown a mailbox's cap, and burying it under two password-shaped options
    // is how they conclude the product does not scale.
    transports: ["oauth", "ses", "mcp", "smtp", "http"],
    oauthProvider: "google",
  },
  {
    id: "whatsapp",
    channelKey: "whatsapp",
    label: "WhatsApp",
    typeLabel: "WhatsApp",
    status: "live",
    blurb: "Template messages, and free-form inside the 24-hour reply window.",
    // Sign-in first, and it is Meta's Embedded Signup rather than a plain consent screen: it
    // creates or claims the account, hands back the number, and can leave the number running
    // in the owner's WhatsApp Business app instead of taking it away from them. The endpoint
    // route stays for a reseller — Wati, Gupshup, AiSensy — and for anyone who would rather
    // paste a token than sign in.
    transports: ["oauth", "http", "mcp"],
  },
  {
    id: "bolna",
    channelKey: "voice",
    label: "Bolna",
    typeLabel: "AI call",
    status: "live",
    blurb: "An AI agent phones the lead and talks through the brief Claude wrote.",
    // Bolna rather than a US voice platform: it dials from Indian numbers, which Vapi and
    // Retell cannot, because TRAI requires Indian calls to terminate on an Indian server.
    transports: ["key"],
  },
  {
    id: "linkedin",
    channelKey: "linkedin",
    label: "LinkedIn",
    typeLabel: "LinkedIn",
    status: "live",
    blurb: "Invites, messages and comments from a connected LinkedIn account.",
    // No sign-in and no vendor: the account owner pastes their own logged-in browser
    // session (method A). A password-driven login with the email-code screen is the "soon"
    // second door — see docs/linkedin-channel-plan.md.
    transports: ["session"],
  },
  {
    id: "sms",
    channelKey: "sms",
    label: "SMS",
    typeLabel: "SMS",
    status: "soon",
    blurb: "Short text to a phone number, where email gets ignored.",
    // Every SMS provider is a token and an endpoint; none of them publish a consent screen.
    transports: ["http", "mcp"],
    waitingOn: "Sender registration per country",
  },
];

export const catalogById = (id: string): ChannelOption | undefined =>
  CHANNEL_CATALOG.find((c) => c.id === id);

/**
 * What to call a channel in a list.
 *
 * Reads the connection's provider first, because that is the fixed id the catalogue set;
 * the channel key is the fallback for rows created before the catalogue existed, and for a
 * bring-your-own channel where the vendor is genuinely the customer's own.
 */
export function channelLabel(channelKey: string, provider?: string): string {
  const byProvider = provider ? catalogById(provider) : undefined;
  if (byProvider) return byProvider.label;

  const byKey = CHANNEL_CATALOG.find((c) => c.channelKey === channelKey);
  return byKey ? byKey.typeLabel : channelKey;
}

/** The transports one channel offers, in the catalogue's order. */
export function transportsFor(optionId: string): typeof TRANSPORTS[number][] {
  const option = catalogById(optionId);
  return TRANSPORTS.filter((t) => option?.transports.includes(t.id));
}

/**
 * What kind of message a channel carries: "Email", "AI call".
 *
 * Read off the key rather than the provider, because the key is the only part that is
 * true of every channel on it. The vendor label is a different fact and is answered by
 * `channelLabel` — conflating the two is what put an MCP send tool called "teamgrid"
 * under a card headed Gmail, where it read as a Google mailbox that had been switched off.
 */
export function channelTypeLabel(channelKey: string): string {
  const byKey = CHANNEL_CATALOG.find((c) => c.channelKey === channelKey);
  return byKey ? byKey.typeLabel : channelKey;
}

/** Each transport, in the past tense a connected row needs. The picker's own labels are
 *  imperative ("Sign in"), which reads as an instruction on a channel already sending. */
const CONNECTED_AS: Record<TransportId, string> = {
  oauth: "signed in",
  ses: "your own domain",
  mcp: "MCP tool",
  smtp: "SMTP",
  http: "API endpoint",
  key: "API key",
  session: "browser session",
};

/**
 * How a connection was made, in words that describe a thing already connected.
 *
 * The stored `authType` is infrastructure vocabulary — `mcp_bearer`, `oauth2`, `bearer` —
 * and the channel's own `kind` only ever says `native` or `mcp`, which told nobody whether
 * a native channel was a signed-in mailbox, a verified domain or an SMTP password.
 *
 * A vendor the catalogue offers exactly one way in wins over the stored type, because the
 * storage is shared and the question is not: a Bolna key is kept as a bearer token like
 * every HTTP endpoint's, and calling it an API endpoint described the column it sits in
 * rather than what anyone pasted.
 */
export function transportLabel(authType?: string, kind?: string, provider?: string): string {
  const offered = provider ? catalogById(provider)?.transports : undefined;
  if (offered?.length === 1 && offered[0]) return CONNECTED_AS[offered[0]];
  if (authType === "oauth2") return CONNECTED_AS.oauth;
  if (authType === "ses") return CONNECTED_AS.ses;
  if (authType === "smtp") return CONNECTED_AS.smtp;
  if (authType === "api_key") return CONNECTED_AS.key;
  if (authType === "bearer") return CONNECTED_AS.http;
  if (authType?.startsWith("mcp") || kind === "mcp") return CONNECTED_AS.mcp;
  return kind ?? "direct";
}

/**
 * The vendor behind a channel, as a name rather than a stored id.
 *
 * A provider the catalogue knows gets its label; one it does not — an MCP server someone
 * named after their own company, an SMTP host — is its own name, which is the honest
 * answer and never another vendor's.
 */
export function providerLabel(provider?: string): string {
  if (!provider) return "direct";
  return catalogById(provider)?.label ?? (provider === "amazonses" ? "Amazon SES" : provider);
}
