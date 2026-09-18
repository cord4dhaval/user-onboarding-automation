import { sendContext } from "./context.js";
import { RetryableSendError, type ChannelAdapter, type OutboundMessage, type SendResult } from "./types.js";

export interface HttpChannelConfig {
  endpointUrl: string;
  method?: string;
  /** Extra headers beyond authorization, as declared when the channel was created. */
  headers?: Record<string, string>;
  /**
   * The provider's own body shape, with "$content.subject" style references. Every provider
   * names these fields differently, so the mapping is data rather than code.
   */
  payloadTemplate: Record<string, unknown>;
  /** Where in the response their identifier lives, e.g. "$.data.id". */
  messageIdPath?: string;
  /**
   * Where the provider says whether it took the message, for one that answers 200 either
   * way — WATI's "$.success". False there is a failed send, not a sent one.
   */
  acceptedPath?: string;
  /**
   * Where the provider puts its reason, tried in order: "$.error", "$.recipients.0.errors".
   * Only these fields are ever read into the row, never the whole body, because error
   * bodies can echo the token back. On a 200, a non-empty one means this recipient failed.
   */
  errorPaths?: string[];
  /** Where a bearer token goes, if not the Authorization header. */
  authHeader?: string;
}

/**
 * Sends through any HTTP endpoint that takes a token — the third way to reach people,
 * alongside SMTP and an MCP tool. A provider with a REST API and no MCP server is the
 * common case, and without this they could only be a source, never a channel.
 */
export class HttpChannelAdapter implements ChannelAdapter {
  readonly key: string;

  constructor(
    key: string,
    private readonly config: HttpChannelConfig,
    private readonly token: string,
  ) {
    this.key = key;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const body = fill(this.config.payloadTemplate, message);
    const header = this.config.authHeader ?? "authorization";
    const value = header.toLowerCase() === "authorization" ? `Bearer ${this.token}` : this.token;

    const res = await fetch(this.config.endpointUrl, {
      method: this.config.method ?? "POST",
      headers: { "content-type": "application/json", [header]: value, ...(this.config.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 || res.status === 503) {
      // Back-pressure, not failure — returning the touch to the queue costs nothing,
      // whereas marking it failed spends a message from the campaign's budget.
      throw new RetryableSendError(`provider is throttling (HTTP ${res.status})`);
    }
    let payload: unknown;
    try {
      payload = (await res.json()) as unknown;
    } catch {
      // A provider that returns no body still accepted the message, when the status says so.
    }
    const reason = this.reasonIn(payload);

    if (!res.ok) {
      // Error bodies routinely echo the token back, so only the status and the declared
      // reason fields are reported.
      throw new Error(`send failed: HTTP ${res.status}${reason ? ` — ${reason}` : ""}`);
    }
    // "OK" to the request is not the provider taking the message. WATI answers 200 for a
    // template that is not approved or a number that is not on WhatsApp, and says so inside.
    const refused = this.config.acceptedPath ? pluck(payload, this.config.acceptedPath) === false : false;
    if (refused || (this.config.errorPaths?.length && reason)) {
      throw new Error(`provider refused the message${reason ? `: ${reason}` : ""}`);
    }

    const found = this.config.messageIdPath ? pluck(payload, this.config.messageIdPath) : undefined;
    const id = typeof found === "string" && found ? found : undefined;
    return { accepted: true, providerMessageId: id, disposition: "sent" };
  }

  /** The provider's own reason, from the declared fields only, cut to a readable length. */
  private reasonIn(payload: unknown): string {
    for (const path of this.config.errorPaths ?? []) {
      const value = pluck(payload, path);
      const text = Array.isArray(value) ? value.filter(Boolean).map(String).join("; ") : value ? String(value) : "";
      if (text.trim()) return text.trim().slice(0, 300);
    }
    return "";
  }
}

/** Walks the template, replacing "$content.subject" style leaves with real values. */
function fill(template: Record<string, unknown>, message: OutboundMessage): Record<string, unknown> {
  const context = sendContext(message);

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.startsWith("$") ? pluck(context, value) ?? "" : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return walk(template) as Record<string, unknown>;
}

function pluck(source: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cursor: unknown = source;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
