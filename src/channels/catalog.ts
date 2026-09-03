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
  { id: "mcp", label: "MCP tool", blurb: "A send tool on a server you already connected." },
  { id: "smtp", label: "SMTP", blurb: "Any mail account or relay, with a password." },
  { id: "http", label: "API endpoint", blurb: "Any provider that takes a token over HTTP." },
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
    transports: ["oauth", "mcp", "smtp", "http"],
    oauthProvider: "google",
  },
  {
    id: "whatsapp",
    channelKey: "whatsapp",
    label: "WhatsApp",
    typeLabel: "WhatsApp",
    status: "soon",
    blurb: "Template messages, and free-form inside the 24-hour reply window.",
    // No sign-in here yet: Meta's flow needs a Business number and approved templates
    // before there is anything to consent to, so offering it would be a dead end.
    transports: ["http", "mcp"],
    waitingOn: "Business API number and template approval",
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
