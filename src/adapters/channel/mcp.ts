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

    // A binding with no `returns` map hands back the provider's whole reply under `raw`,
    // so every id lookup here missed and every send was recorded with no provider id at
    // all — nothing to reconcile against, and no way to ask the provider what happened.
    const payload = (mapped.raw && typeof mapped.raw === "object" ? mapped.raw : mapped) as Record<string, unknown>;
    const fields = { ...payload, ...mapped };

    // The call succeeding is not the mail being accepted. A provider that refuses a
    // recipient says so in the body it returns, and treating that as sent leaves a
    // campaign reporting delivery it never made.
    const refusal = refusalIn(fields);
    if (refusal) throw new Error(`provider refused the message: ${refusal}`);

    const jobs = fields.jobIds ?? fields.job_ids;
    const id =
      fields.message_id ??
      fields.messageId ??
      fields.batchId ??
      fields.batch_id ??
      fields.id ??
      fields.jobId ??
      (Array.isArray(jobs) ? jobs[0] : undefined);

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

/**
 * An explicit refusal in a provider's reply, or nothing.
 *
 * Only fields that plainly carry a verdict are read. Scanning the whole body for the word
 * "error" would fail a send whose reply happens to describe an error count of zero.
 */
function refusalIn(fields: Record<string, unknown>): string | undefined {
  if (fields.ok === false || fields.success === false || fields.sent === false) {
    return String(fields.message ?? fields.error ?? fields.reason ?? "the provider reported failure");
  }
  const status = typeof fields.status === "string" ? fields.status : undefined;
  if (status && /fail|error|reject|refus|bounce|blocked/i.test(status)) return status;
  const error = fields.error ?? fields.errorMessage ?? fields.error_message;
  if (typeof error === "string" && error.trim()) return error;
  return undefined;
}
