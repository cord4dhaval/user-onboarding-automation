import type { OutboundMessage } from "./types.js";

/**
 * A phone number as digits with its country code.
 *
 * Forms take numbers the way people type them, and people in India type ten digits: 11 of
 * TeamGrid's leads were stored as "98xxxxxxxx", which a WhatsApp provider reads as a number
 * in some other country, or not at all. Only an unambiguous shape is completed: ten digits
 * starting 6 to 9 is an Indian mobile, and so is the same number written with a leading 0.
 * A number written with "+" already says its country and is left exactly as given.
 */
export function phoneDigits(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (value.trim().startsWith("+")) return digits;
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  return digits;
}

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
      phoneDigits: phoneDigits(phone),
    },
    content: { subject: message.subject, body: message.bodyText, bodyHtml: message.bodyHtml },
    channel: { from: message.from, replyTo: message.replyTo },
    vars,
    /**
     * The provider's own approved template and its parameters, for channels that send by
     * name rather than by body. Empty name where the message carries prose instead.
     *
     * The name is written after the spread, not before. Wati's most common template
     * variable is literally called `name`, and spread last it replaced the template name
     * with the recipient's first name — every send then asked Wati for a template called
     * "Priya". Parameters stay reachable at the top level for mappings already written,
     * and under `params` for the one whose key collides: `$template.params.name`.
     */
    template: {
      ...(message.providerTemplate?.params ?? {}),
      name: message.providerTemplate?.name ?? "",
      params: message.providerTemplate?.params ?? {},
      /**
       * Every parameter as { name, value }, the list shape WATI's custom_params takes. A
       * payload that listed its parameters by hand sent only those, so a template with a
       * second variable went out with it blank.
       */
      paramList: Object.entries(message.providerTemplate?.params ?? {}).map(([name, value]) => ({ name, value })),
      /**
       * The same parameters as `{ type: "text", text }`, in order and without their names —
       * the shape Meta's Cloud API takes for a template whose variables are positional,
       * which every template of ours is. Order comes from the template row's own mapping,
       * so a row that lists its variables out of order sends them out of order; there is
       * nothing in a positional template to check that against.
       */
      paramTexts: Object.values(message.providerTemplate?.params ?? {}).map((value) => ({ type: "text", text: value })),
    },
    /** Our id for this message, for a provider that echoes one back on its status events. */
    message: { id: message.ref ?? "" },
  };
}
