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
  };
}

/**
 * Candidate tools for each adapter verb. Claude ranks these and proposes a binding; the
 * user confirms or overrides in the UI. Nothing here is ever auto-applied — a wrong guess
 * about which tool sends mail is expensive.
 */
export function candidatesFor(
  verb: "send" | "send_status" | "fetch_leads" | "poll_inbound" | "health",
  tools: McpTool[],
): McpTool[] {
  const patterns: Record<typeof verb, RegExp> = {
    send: /^(?!.*status).*(send|deliver|dispatch|mail|message)/i,
    send_status: /(send|mail|delivery).*(status|state)|status.*(send|mail)/i,
    fetch_leads: /lead|contact|signup|pipeline|crm|new_user|subscriber/i,
    poll_inbound: /inbound|repl(y|ies)|receive|conversation/i,
    health: /health|quota|status|ping|limit/i,
  };
  const re = patterns[verb];
  return tools.filter((t) => re.test(t.name) || (t.description ? re.test(t.description) : false));
}
