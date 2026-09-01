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
    if (!res.ok) {
      // Error bodies routinely echo the token back, so only the status is reported.
      throw new Error(`send failed: HTTP ${res.status}`);
    }

    let id: string | undefined;
    try {
      const payload = (await res.json()) as unknown;
      const found = this.config.messageIdPath ? pluck(payload, this.config.messageIdPath) : undefined;
      if (typeof found === "string") id = found;
    } catch {
      // A provider that returns no body still accepted the message.
    }

    return { accepted: true, providerMessageId: id, disposition: "sent" };
  }
}

/** Walks the template, replacing "$content.subject" style leaves with real values. */
function fill(template: Record<string, unknown>, message: OutboundMessage): Record<string, unknown> {
  const context: Record<string, unknown> = {
    person: { email: message.to },
    content: { subject: message.subject, body: message.bodyText, bodyHtml: message.bodyHtml },
    channel: { from: message.from, replyTo: message.replyTo },
  };

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
