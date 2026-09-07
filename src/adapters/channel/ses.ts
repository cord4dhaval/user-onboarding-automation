import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { buildRawMime } from "./gmail.js";
import { RetryableSendError, type ChannelAdapter, type OutboundMessage, type SendResult } from "./types.js";

/**
 * Sends through Amazon SES, as a domain the customer owns and verified by DNS.
 *
 * The other half of the Gmail adapter rather than a replacement for it. Gmail sends from a
 * person's mailbox, which is why cold mail from it reaches an inbox, and is capped at what
 * one human could plausibly send — 500 a day, 2,000 on Workspace. SES sends from a domain
 * with no such ceiling, and no mailbox behind it: nothing arrives back, so a tenant sending
 * here still connects Gmail for reading replies. That pairing is enforced by the channel's
 * health rule, not here.
 *
 * One AWS account carries every tenant. That means one shared reputation: a single customer
 * mailing a bought list puts every other customer's sending at risk, which is the argument
 * for the per-tenant complaint watch rather than trusting the account-wide numbers.
 */

export interface SesConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Per-tenant, so bounce and complaint events arrive labelled with whose they are. */
  configurationSetName?: string;
  /**
   * The SES tenant this customer sends as, when one exists.
   *
   * Sending through a tenant is what keeps one customer's bounces, complaints and
   * suppressions off everybody else's reputation. Absent where the account could not create
   * one, in which case sending falls back to account level — the behaviour before tenants,
   * and recorded on the connection so the gap is visible.
   */
  tenantName?: string;
}

export class SesAdapter implements ChannelAdapter {
  readonly key: string;
  private client: SESv2Client;

  constructor(
    key: string,
    private readonly config: SesConfig,
    private readonly defaultFrom: string,
  ) {
    this.key = key;
    this.client = new SESv2Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const from = message.from ?? this.defaultFrom;
    // Raw rather than the Simple content shape, because Simple has nowhere to put
    // In-Reply-To and References. A provider that cannot carry those headers cannot hold a
    // conversation, and the whole reply path depends on it holding one.
    const raw = await buildRawMime({ ...message, from });

    let response;
    try {
      response = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [message.to] },
          ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
          Content: { Raw: { Data: Buffer.from(raw, "base64url") } },
          ConfigurationSetName: this.config.configurationSetName,
          // Refused unless the identity and configuration set are both associated with this
          // tenant, which is why connectSesDomain records a tenant only once both are.
          TenantName: this.config.tenantName,
        }),
      );
    } catch (err) {
      throw sendError(err);
    }

    // SES's MessageId is not an opaque handle: the id it puts in the recipient's headers is
    // this value at the region's amazonses.com. Knowing it without asking is why threading
    // costs nothing here, where Gmail needs a round trip to discover what it stamped.
    const messageId = response.MessageId
      ? `<${response.MessageId}@${this.config.region}.amazonses.com>`
      : undefined;

    // SES accepting a message is the same promise SMTP makes — it is queued and out of our
    // hands. Whether it landed arrives later as a Delivery or Bounce event on the
    // configuration set, which is the thing Gmail never offered.
    return { accepted: true, providerMessageId: response.MessageId, disposition: "sent", messageId };
  }
}

/**
 * Splits SES's failures into wait and stop, the same two outcomes the engine understands.
 *
 * Getting it wrong costs a touch from a campaign's budget for a message nobody received, or
 * an infinite retry against a domain that will never be allowed to send.
 */
function sendError(err: unknown): Error {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0;

  // The account's own send rate, measured per second. A short wait clears it; SES publishes
  // no retry hint, so this backs off far enough to matter without stalling the queue.
  if (name === "TooManyRequestsException" || name === "ThrottlingException" || status === 429) {
    return new RetryableSendError(`ses throttled: ${message}`, 120);
  }
  if (status >= 500) return new RetryableSendError(`ses ${status}: ${message}`, 120);

  // Sending paused for this account or this configuration set. Almost always a complaint or
  // bounce rate AWS has decided to act on, so it needs a human, not a retry.
  if (name === "AccountSuspendedException" || name === "SendingPausedException") {
    return new Error(`ses sending is paused for this account — check the SES reputation dashboard: ${message}`);
  }
  if (name === "MailFromDomainNotVerifiedException" || name === "NotFoundException") {
    return new Error(`ses identity is not verified — reconnect this domain: ${message}`);
  }
  // Sandbox. The message is fine and the recipient is not verified, which reads as a
  // per-message failure and is really the account still waiting on production access.
  if (name === "MessageRejected" && /not verified/i.test(message)) {
    return new Error(`ses is still in sandbox — request production access: ${message}`);
  }
  return new Error(`ses send failed: ${message}`);
}
