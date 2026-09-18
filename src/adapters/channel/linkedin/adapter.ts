/**
 * The LinkedIn channel adapter. Unlike a mailbox, one "send" is four different LinkedIn
 * calls — invite, direct message, comment, reply — so it reads `op` off the outbound message
 * and dispatches. The session is resolved by the broker and handed in as JSON.
 *
 * An invite is accepted or it is not, later, by the other person. The touch itself is done
 * the moment LinkedIn takes it, so it reports `sent`; acceptance is the lead's state, and a
 * DM sent before it simply waits (see NOT_FIRST_DEGREE below).
 *
 * Session death is not a failed send. When Voyager bounces the session, `voyagerFetch`
 * throws a SessionError; this adapter turns it into a ChannelDownError, which the send path
 * answers by holding the channel's queue and turning the row red with a reconnect reason,
 * rather than burning the touch.
 */

import { LinkedInClient } from "./client.js";
import { SessionError, type LinkedInSession } from "./session.js";
import {
  ChannelDownError,
  RetryableSendError,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from "../types.js";

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

  /** The member id behind a profile slug. One profile view; the send path caches it. */
  async resolveRecipient(slug: string): Promise<string> {
    try {
      return (await this.client.profileBySlug(slug)).providerId;
    } catch (err) {
      throw sessionDown(err);
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const op = message.op ?? "invite";
    try {
      // The send path passes the cached member id. Looking it up here is only the fallback
      // for a caller that did not, and it costs a profile view.
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
      // A DM to someone who has not accepted the invite yet: wait, do not fail. The touch is
      // held and retried, so once they accept, the same message goes out.
      if (err instanceof Error && /NOT_FIRST_DEGREE/.test(err.message)) {
        throw new RetryableSendError("waiting for the connection to be accepted", 6 * 3600);
      }
      throw sessionDown(err);
    }
  }
}

/**
 * A dead or blocked session is the channel's problem, not this message's. Everything else
 * passes through untouched.
 *
 * All three kinds stop the channel. An expired session and a checkpoint both need the owner
 * back in their browser; a 999 is LinkedIn saying it has noticed the account, and the one
 * thing that makes that worse is carrying on.
 */
function sessionDown(err: unknown): unknown {
  if (!(err instanceof SessionError)) return err;
  return new ChannelDownError(err.message, err.kind !== "restricted");
}
