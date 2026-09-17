/**
 * The LinkedIn channel adapter. Unlike a mailbox, one "send" is four different LinkedIn
 * calls — invite, direct message, comment, reply — so it reads `op` off the outbound message
 * and dispatches. The session is resolved by the broker and handed in as JSON.
 *
 * An invite is not delivered-and-done: it is accepted or it is not, later, by the other
 * person. So an invite reports `queued`, and the reconciler resolves it when the acceptance
 * poll sees the connection form. Messages and comments are synchronous.
 *
 * Session death is not a failed send. When Voyager bounces the session, `voyagerFetch`
 * throws a SessionError; the send path turns that into a reconnect prompt on the channel
 * rather than burning the touch.
 */

import { LinkedInClient } from "./client.js";
import { SessionError, type LinkedInSession } from "./session.js";
import { RetryableSendError, type ChannelAdapter, type OutboundMessage, type SendResult } from "../types.js";

export class LinkedInChannelAdapter implements ChannelAdapter {
  private readonly client: LinkedInClient;

  constructor(
    readonly key: string,
    session: LinkedInSession,
    /** The connected account's own member id — the mailbox a DM is sent from. */
    ownProviderId?: string,
  ) {
    this.client = new LinkedInClient(session, ownProviderId);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.providerId && message.op !== "comment" && message.op !== "reply") {
      throw new Error("LinkedIn send has no target member (providerId)");
    }
    try {
      switch (message.op) {
        case "invite": {
          const { invitationUrn } = await this.client.sendInvite(message.providerId!, message.note ?? message.bodyText);
          // An invite is accepted later or never. Queued, resolved by the acceptance poll.
          return { accepted: true, disposition: "queued", providerMessageId: invitationUrn };
        }
        case "message": {
          const { conversationUrn } = await this.client.sendMessage(
            message.providerId!,
            message.bodyText,
            message.conversationUrn,
          );
          return { accepted: true, disposition: "sent", threadId: conversationUrn, providerMessageId: conversationUrn };
        }
        case "comment":
        case "reply": {
          if (!message.postUrn) throw new Error("LinkedIn comment has no post");
          const { commentUrn } = await this.client.comment(
            message.postUrn,
            message.bodyText,
            message.op === "reply" ? message.parentCommentUrn : undefined,
          );
          return { accepted: true, disposition: "sent", providerMessageId: commentUrn };
        }
        default:
          throw new Error(`LinkedIn adapter cannot handle op "${message.op ?? "message"}"`);
      }
    } catch (err) {
      // A dead or blocked session is back-pressure the channel must surface as a reconnect,
      // not a per-message failure. Rethrow as retryable so the touch is not spent; the send
      // path marks the credential and flips the channel unhealthy.
      if (err instanceof SessionError) {
        throw new RetryableSendError(err.message, err.kind === "restricted" ? 3600 : 300);
      }
      throw err;
    }
  }
}
