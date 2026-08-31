export interface OutboundMessage {
  to: string;
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  from?: string;
  replyTo?: string;
}

export interface SendResult {
  providerMessageId?: string;
  accepted: boolean;
  /**
   * "sent" — the provider delivered it synchronously.
   * "queued" — the provider accepted it for later delivery, so the real outcome is only
   * known once the status tool is polled. Reporting queued as sent would be a lie.
   */
  disposition: "sent" | "queued";
  detail?: string;
}

/**
 * Back-pressure, not failure. A full provider queue means try again shortly — treating it
 * as a failed send would burn a touch from the goal's budget for a message nobody got.
 */
export class RetryableSendError extends Error {
  constructor(message: string, readonly retryAfterSec = 300) {
    super(message);
    this.name = "RetryableSendError";
  }
}

export interface ChannelAdapter {
  readonly key: string;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Present only where the provider delivers asynchronously. */
  checkStatus?(providerMessageId: string): Promise<"queued" | "sending" | "sent" | "failed">;
}
