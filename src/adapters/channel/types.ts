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
  /**
   * Where this person leaves, as a header rather than only as a link in the body.
   *
   * Gmail and Yahoo require it of anyone sending them bulk mail, and they enforce it by
   * placing their own unsubscribe control next to the sender's name — which is a better
   * outcome than the alternative the reader reaches for, which is the spam button. A
   * complaint costs far more than an unsubscribe: it is the number that suspends a sending
   * account, and it is attributed for months.
   */
  listUnsubscribeUrl?: string;
  /**
   * The merge variables this message was rendered with.
   *
   * Carried alongside the rendered body because not every provider takes a body. WhatsApp
   * outside the reply window accepts an approved template name and a set of named
   * parameters and nothing else, so the values have to survive the render rather than being
   * dissolved into prose. Adapters that send text ignore this.
   */
  vars?: Record<string, string>;
  /**
   * The provider's own approved template, where the channel sends by name rather than by
   * content. Set only for channels whose provider works that way; absent means send the
   * body above.
   */
  providerTemplate?: { name: string; params: Record<string, string> };
  /**
   * What a LinkedIn touch actually is. Unlike email, "send" is not one shape on LinkedIn: an
   * invite, a direct message, a comment and a reply are different calls with different
   * targets. The adapter reads `op` to pick the call; the fields below carry its target.
   *
   * `providerId` is the member (urn:li:fsd_profile:…), resolved once from the person's
   * LinkedIn URL and cached on them. `conversationUrn` threads a DM; `postUrn` /
   * `parentCommentUrn` target a comment or a reply. Absent on every non-LinkedIn channel.
   */
  op?: "invite" | "message" | "comment" | "reply";
  providerId?: string;
  note?: string;
  conversationUrn?: string;
  postUrn?: string;
  parentCommentUrn?: string;
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
  /** The conversation this landed in. Free in the send response — no extra round trip. */
  threadId?: string;
  /**
   * The RFC 5322 Message-ID this message was delivered with, when the provider says so at
   * send time.
   *
   * Set by providers whose response determines it — SES returns the id its header will
   * carry. Left undefined by Gmail, which discards what the sender supplied and stamps its
   * own; that one is discovered later, by the first follow-up that needs it, through
   * resolveMessageId. Both paths end at the same stored value.
   */
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

/**
 * The channel itself cannot send until a person fixes it: a LinkedIn session that ended, an
 * account the provider started blocking. Retryable for the message, because nothing went
 * out and the touch is not spent, but the send path also takes the channel down, so the
 * queue stops knocking on a door that will not open and the row says why.
 *
 * `sessionEnded` separates "the stored login is dead, paste a new one" from "the login may
 * be fine but the provider is pushing back"; only the first marks the credential expired.
 */
export class ChannelDownError extends RetryableSendError {
  constructor(
    message: string,
    readonly sessionEnded: boolean,
  ) {
    super(message, 3600);
    this.name = "ChannelDownError";
  }
}

/** What a voice call came to, read back from the provider. */
export interface CallResult {
  /** The provider's own word for where the call is: "ringing", "completed", "no-answer". */
  status: string;
  /** Ended, one way or the other. Until then nothing below is filled in. */
  done: boolean;
  /** Someone picked up and the agent spoke. A call that rang out is done but not connected. */
  connected: boolean;
  durationSec?: number;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  hangupReason?: string;
  costCents?: number;
  extracted?: Record<string, unknown>;
  error?: string;
  endedAt?: Date;
}

export interface ChannelAdapter {
  readonly key: string;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Present only where the provider delivers asynchronously. */
  checkStatus?(providerMessageId: string): Promise<"queued" | "sending" | "sent" | "failed">;
  /**
   * Present only on voice. A call has more to report than delivered or not — who answered,
   * for how long, and what was said — and the next run reads all of it.
   */
  callResult?(providerMessageId: string): Promise<CallResult>;
  /**
   * The RFC 5322 Message-ID a provider actually stamped on a message it sent, which is not
   * the provider's own id for it.
   *
   * Asked for lazily, by the first follow-up that needs something to reference, rather than
   * after every send: most messages never get a second touch, and a round trip spent on all
   * of them to serve the few is the difference between 25 sends fitting in the cron budget
   * and not. Resolved once and stored on the action.
   */
  resolveMessageId?(providerMessageId: string): Promise<string | undefined>;
  /**
   * Present only where the address on the person is not what the provider sends to: a
   * LinkedIn profile slug has to be looked up to a member id, and every lookup is a profile
   * view against the account's daily allowance. The send path asks once and caches the
   * answer on the person, so a lead costs one lookup however many touches follow.
   */
  resolveRecipient?(to: string): Promise<string>;
}
