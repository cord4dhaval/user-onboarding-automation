import MailComposer from "nodemailer/lib/mail-composer";
import { RetryableSendError, type ChannelAdapter, type OutboundMessage, type SendResult } from "./types.js";

/**
 * Sends through the customer's own Gmail mailbox over the Gmail API.
 *
 * Chosen over SMTP-with-an-app-password for two reasons. The obvious one is that nobody
 * types a password into our form. The less obvious one is that Google is steadily closing
 * password-based access, so an SMTP channel is a channel with an expiry date nobody told
 * us about.
 *
 * What this buys over an ESP: mail leaves a real person's mailbox, which is why cold
 * outreach from it lands in an inbox rather than a promotions tab. What it costs: no
 * delivery webhook and a hard daily ceiling — 500 recipients on a consumer account, 2,000
 * on Workspace. The ceiling is enforced by the channel governor, not here; a message this
 * adapter refuses is a message already sent.
 */

const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class GmailAdapter implements ChannelAdapter {
  readonly key: string;

  constructor(
    key: string,
    /**
     * Already-fresh access token. The broker refreshes ahead of expiry, so the adapter
     * never holds a refresh token and a send never waits on a token round-trip.
     */
    private readonly accessToken: string,
    private readonly defaultFrom: string,
  ) {
    this.key = key;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const raw = await buildRawMime({ ...message, from: message.from ?? this.defaultFrom });

    const res = await fetch(GMAIL_SEND, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    if (!res.ok) throw sendError(res.status, text);

    const body = JSON.parse(text) as { id?: string; threadId?: string };
    // Gmail accepting the message is the same guarantee SMTP gives: it is out of our
    // hands and on its way. A bounce, if there is one, arrives later as mail — which is
    // what the inbound poller reads.
    return { accepted: true, providerMessageId: body.id, disposition: "sent", detail: body.threadId };
  }
}

/**
 * Translates Gmail's failure vocabulary into the two outcomes the engine understands:
 * wait, or stop.
 *
 * Getting this wrong in either direction is expensive. A rate limit treated as a failure
 * burns a touch from the campaign's budget for a message nobody received; a hard rejection
 * treated as back-pressure retries forever against a mailbox that will never accept it.
 */
function sendError(status: number, body: string): Error {
  const reason = /"reason":\s*"([^"]+)"/.exec(body)?.[1] ?? "";
  const detail = body.slice(0, 300);

  // The daily cap. Retrying inside the hour achieves nothing — Gmail's quota is a rolling
  // 24 hours — so this waits it out rather than hammering.
  if (/dailyLimitExceeded|Daily Limit Exceeded|quotaExceeded/i.test(body) && !/userRateLimit/i.test(reason)) {
    return new RetryableSendError(`gmail daily quota: ${detail}`, 3 * 3600);
  }
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(reason)) {
    return new RetryableSendError(`gmail rate limit: ${detail}`, 300);
  }
  if (status >= 500) return new RetryableSendError(`gmail ${status}: ${detail}`, 120);

  // 401 means the token is dead despite the broker's refresh — the customer revoked access
  // or changed their password. Saying so plainly is what turns a stuck channel into a
  // "reconnect this mailbox" prompt instead of a mystery.
  if (status === 401) return new Error(`gmail rejected the token — this mailbox needs reconnecting: ${detail}`);
  if (status === 403 && /insufficient|ACCESS_TOKEN_SCOPE/i.test(body)) {
    return new Error(`gmail scope missing (reconnect with send scope): ${detail}`);
  }
  return new Error(`gmail send failed ${status}: ${detail}`);
}

/**
 * Builds the RFC 822 message Gmail wants, base64url encoded.
 *
 * nodemailer's composer is reused rather than assembling headers by hand: multipart
 * boundaries, quoted-printable, header folding and non-ASCII subjects are all places where
 * a hand-rolled MIME builder produces mail that renders correctly in the one client the
 * author tested and nowhere else.
 */
export async function buildRawMime(message: OutboundMessage): Promise<string> {
  const composed = await new MailComposer({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.bodyText,
    html: message.bodyHtml,
    replyTo: message.replyTo,
  })
    .compile()
    .build();
  return composed.toString("base64url");
}
