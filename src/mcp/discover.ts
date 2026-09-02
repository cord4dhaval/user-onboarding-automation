import type { McpTool } from "./client.js";

/**
 * Capability resolution runs in three tiers: declared (the server tells us), inferred
 * (we read its tool schemas), probed (we test it live). Declared wins where present,
 * a probe overrides an inference, and anything still unknown stays false.
 *
 * Defaulting an unconfirmed capability to true is the worst available bug: temperature
 * scoring silently treats every lead as never-having-opened, and nothing errors.
 */
export type CapabilitySource = "declared" | "inferred" | "probed" | "human";

export interface Capability {
  value: boolean | string | number;
  source: CapabilitySource;
  confidence: number;
  verifiedAt: Date;
}

function argNames(tool: McpTool): string[] {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
  return props ? Object.keys(props) : [];
}

const has = (tools: McpTool[], re: RegExp) => tools.some((t) => re.test(t.name));
const hasArg = (tool: McpTool | undefined, re: RegExp) =>
  tool ? argNames(tool).some((a) => re.test(a)) : false;

/**
 * Derives most of a channel's capability sheet from the tool list alone, so a product
 * that never publishes a capability document still gets correct planner behaviour.
 */
export function inferCapabilities(tools: McpTool[]): Record<string, Capability> {
  const now = new Date();
  const sendTool = tools.find((t) => /send|deliver|dispatch|message|mail/i.test(t.name));
  const mark = (value: boolean | string, confidence = 0.7): Capability => ({
    value,
    source: "inferred",
    confidence,
    verifiedAt: now,
  });

  return {
    send: mark(Boolean(sendTool), sendTool ? 0.9 : 0.9),
    html: mark(hasArg(sendTool, /html|body_html|content_html/i)),
    attachments: mark(hasArg(sendTool, /attach|file|media/i)),
    trackingOpens: mark(
      hasArg(sendTool, /track_open|open_tracking/i) || has(tools, /open|engagement/i),
      0.6,
    ),
    trackingClicks: mark(
      hasArg(sendTool, /track_click|click_tracking/i) || has(tools, /click/i),
      0.6,
    ),
    bounceWebhook: mark(has(tools, /bounce|suppress|complaint/i), 0.6),
    inboundReplies: mark(has(tools, /inbound|repl(y|ies)|receive|messages_list/i), 0.6),
    fromDomain: mark(
      hasArg(sendTool, /^from/i) ? "caller_controlled" : "controlled_by_provider",
      0.7,
    ),
    idempotencySupported: mark(hasArg(sendTool, /idempot|request_id|dedupe/i), 0.7),
    brand: mark(has(tools, /brand|palette|design_?token|styleguide/i), 0.7),
  };
}

/**
 * Candidate tools for each adapter verb, best first.
 *
 * Matching on the description alone is worse than useless here: "mail" appears inside
 * "email", so every tool whose description mentions an email address looked like a sender.
 * A name match therefore outranks a description match, and for verbs that act on the world
 * the obvious readers are excluded outright — get_email_tokens is never a way to send one.
 */
export type Verb = "send" | "send_status" | "fetch_leads" | "poll_inbound" | "health" | "fetch_brand";

const PATTERNS: Record<Verb, { name: RegExp; description?: RegExp; excludeReaders?: boolean }> = {
  send: {
    name: /(^|_)(send|deliver|dispatch|post|publish|notify|email|mail|message|sms|text)(_|$)/i,
    description: /\b(sends?|delivers?|dispatches)\b/i,
    excludeReaders: true,
  },
  send_status: {
    name: /(status|state).*(send|mail|message|delivery)|(send|mail|message|delivery).*(status|state)/i,
  },
  fetch_leads: {
    name: /(^|_)(lead|leads|contact|contacts|signup|signups|subscriber|pipeline|crm|new_user)(_|$)/i,
    description: /\b(leads?|contacts?|signups?)\b/i,
  },
  poll_inbound: {
    name: /(^|_)(inbound|repl(y|ies)|receive|conversation|messages?)(_|$)/i,
  },
  health: {
    name: /(^|_)(health|quota|status|ping|limits?|settings)(_|$)/i,
  },
  /**
   * A brand sheet is read, not sent, so the reader exclusion that protects `send` would
   * throw away exactly the tool wanted here — get_brand_style is the archetype.
   */
  fetch_brand: {
    name: /(^|_)(brand|branding|style|styles|identity|theme|palette|design_?tokens?|styleguide|brandkit)(_|$)/i,
    description: /\b(brand|palette|design tokens?|style guide)\b/i,
  },
};

/** Tools that plainly only read. Nothing named this way sends anything. */
const READER = /^(get|list|search|fetch|read|describe|inspect|count|export)_/i;

export function candidatesFor(verb: Verb, tools: McpTool[]): McpTool[] {
  const pattern = PATTERNS[verb];
  const scored: Array<{ tool: McpTool; score: number }> = [];

  for (const tool of tools) {
    if (pattern.excludeReaders && READER.test(tool.name)) continue;

    let score = 0;
    if (pattern.name.test(tool.name)) score += 10;
    if (pattern.description && tool.description && pattern.description.test(tool.description)) score += 3;
    if (score > 0) scored.push({ tool, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.tool);
}
