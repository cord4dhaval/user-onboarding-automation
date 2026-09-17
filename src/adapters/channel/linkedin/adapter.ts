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
    const op = message.op ?? "invite";
    try {
      // The target member id. The engine passes the profile slug as `to`; resolving it to a
      // provider id is one profile view, so it happens here rather than in the send loop.
      const providerId =
        message.providerId ??
        (op === "invite" || op === "message"
          ? (await this.client.profileBySlug(message.to)).providerId
          : undefined);

      switch (op) {
        case "invite": {
          const { invitationUrn, already } = await this.client.sendInvite(providerId!, message.note ?? message.bodyText);
          // The invite is a completed touch; whether it is accepted is the lead's state, not
          // this send's. `already` means an invite was pending or they are connected — still
          // done, so the ladder does not retry.
          return {
            accepted: true,
            disposition: "sent",
            providerMessageId: invitationUrn || undefined,
            detail: already ? "already invited or connected" : "invite sent",
          };
        }
        case "message": {
          const { conversationUrn } = await this.client.sendMessage(providerId!, message.bodyText, message.conversationUrn);
          return { accepted: true, disposition: "sent", threadId: conversationUrn, providerMessageId: conversationUrn };
        }
        case "comment":
        case "reply": {
          if (!message.postUrn) throw new Error("LinkedIn comment has no post");
          const { commentUrn } = await this.client.comment(
            message.postUrn,
            message.bodyText,
            op === "reply" ? message.parentCommentUrn : undefined,
          );
          return { accepted: true, disposition: "sent", providerMessageId: commentUrn };
        }
        default:
          throw new Error(`LinkedIn adapter cannot handle op "${op}"`);
      }
    } catch (err) {
      // A dead or blocked session is back-pressure the channel must surface as a reconnect,
      // not a per-message failure. Rethrow as retryable so the touch is not spent.
      if (err instanceof SessionError) {
        throw new RetryableSendError(err.message, err.kind === "restricted" ? 3600 : 300);
      }
      // A DM to someone who has not accepted the invite yet: wait, do not fail. The touch is
      // held and retried, so once they accept, the same message goes out.
      if (err instanceof Error && /NOT_FIRST_DEGREE/.test(err.message)) {
        throw new RetryableSendError("waiting for the connection to be accepted", 6 * 3600);
      }
      throw err;
    }
  }
}
