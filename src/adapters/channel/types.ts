export interface OutboundMessage {
  to: string;
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  from?: string;
  replyTo?: string;
  /**
   * The conversation this message belongs to, when it is not the first one.
   *
   * `threadId` is the provider's own handle and is what actually groups the message in the
   * recipient's client. `inReplyTo` and `references` are the RFC 5322 headers that every
   * other mail client threads on, so both are set: a provider id alone threads in Gmail and
   * nowhere else.
   */
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
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
  /** The conversation this landed in, and the id later messages must reference to join it. */
  threadId?: string;
  messageId?: string;
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
