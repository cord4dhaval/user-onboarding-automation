import type { OutboundMessage } from "./types.js";

/**
 * Every value a channel's argument mapping may reference, in one place.
 *
 * Both the HTTP adapter's payload template and the MCP binding's argument map are
 * user-written references into this shape, and they were building it separately from the
 * same three fields. That was survivable while every channel was email and became a bug the
 * moment one was not: `$person.email` was the only way to name a recipient, so a WhatsApp
 * mapping had nothing correct to point at. One builder means a reference that works in the
 * payload box works in the argument box too.
 */
export function sendContext(message: OutboundMessage): Record<string, unknown> {
  const vars = message.vars ?? {};
  const phone = vars.phone ?? "";

  return {
    /** Whatever addresses this channel — an inbox on email, a number on WhatsApp. */
    to: message.to,
    person: {
      ...vars,
      // Falls back to the address for messages rendered without merge vars — previews and
      // tests — so mappings written before this kept working. A fallback and not the
      // source: on a WhatsApp channel the address is a phone number, and resolving
      // `$person.email` to one would be a quiet lie in a field someone is reading.
      email: vars.email ?? message.to,
      phone,
      /** Digits with country code and nothing else, which is what most providers accept. */
      phoneDigits: phone.replace(/[^0-9]/g, ""),
    },
    content: { subject: message.subject, body: message.bodyText, bodyHtml: message.bodyHtml },
    channel: { from: message.from, replyTo: message.replyTo },
    vars,
    /**
     * The provider's own approved template and its parameters, for channels that send by
     * name rather than by body. Empty name where the message carries prose instead.
     */
    template: { name: message.providerTemplate?.name ?? "", ...(message.providerTemplate?.params ?? {}) },
  };
}
