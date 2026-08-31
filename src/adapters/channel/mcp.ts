import type { McpClient } from "../../mcp/client.js";
import { invoke, type Binding } from "../../mcp/binding.js";
import { RetryableSendError, type ChannelAdapter, type OutboundMessage, type SendResult } from "./types.js";

/**
 * Sends through whatever tool the product's MCP exposes. Tool name and argument mapping
 * come from the binding the user confirmed at connect time, so two products with entirely
 * different tool names share this one implementation.
 */
export class McpChannelAdapter implements ChannelAdapter {
  readonly key: string;

  constructor(
    key: string,
    private readonly client: McpClient,
    private readonly binding: Binding,
    /** A bound status verb means delivery is asynchronous and must be reconciled later. */
    private readonly asyncDelivery = false,
  ) {
    this.key = key;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    let mapped: Record<string, unknown>;
    try {
      mapped = await invoke(this.client, this.binding, "send", {
        person: { email: message.to },
        content: {
          subject: message.subject,
          body: message.bodyText,
          bodyHtml: message.bodyHtml,
        },
        channel: { from: message.from, replyTo: message.replyTo },
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      // Providers signal a full queue as an ordinary error; it means wait, not give up.
      if (/queue_full|rate.?limit|too many requests|429/i.test(text)) {
        throw new RetryableSendError(text);
      }
      throw err;
    }

    const id =
      mapped.message_id ?? mapped.messageId ?? mapped.batchId ?? mapped.batch_id ?? mapped.id ?? mapped.jobId;

    return {
      accepted: true,
      providerMessageId: typeof id === "string" ? id : undefined,
      disposition: this.asyncDelivery ? "queued" : "sent",
    };
  }

  async checkStatus(providerMessageId: string): Promise<"queued" | "sending" | "sent" | "failed"> {
    const mapped = await invoke(this.client, this.binding, "send_status", {
      batchId: providerMessageId,
      jobId: providerMessageId,
    });
    const raw = JSON.stringify(mapped.status ?? mapped.raw ?? mapped).toLowerCase();
    if (/"?failed|"?error|bounced/.test(raw)) return "failed";
    if (/"?sent|delivered|complete/.test(raw)) return "sent";
    if (/sending|processing|in_progress/.test(raw)) return "sending";
    return "queued";
  }
}
