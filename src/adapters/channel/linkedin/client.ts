/**
 * A thin client over LinkedIn's Voyager API for one session. No SDK: the official
 * unipile-style packages are unmaintained and LinkedIn's own paths move, so a small fetch
 * client we control is less to keep alive.
 *
 * Read ops (me, profileBySlug) are solid and the connect/health flow rides on them. Write
 * ops (invite, message, comment, react) carry the request shapes as best known, but the
 * exact bodies and GraphQL query ids rotate — each is marked and must be confirmed against a
 * live logged-in session before it is switched on in the send path. Until then they will
 * throw rather than send something malformed.
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as E from "./endpoints.js";
import { voyagerFetch, voyagerJson, type LinkedInSession } from "./session.js";

export interface Me {
  providerId: string; // urn:li:fs_miniProfile:ACoAAB... — the person's stable id
  publicIdentifier: string;
  firstName: string;
  lastName: string;
}

export type Distance = "SELF" | "DISTANCE_1" | "DISTANCE_2" | "DISTANCE_3" | "OUT_OF_NETWORK";

export interface Profile {
  providerId: string;
  publicIdentifier: string;
  firstName: string;
  lastName: string;
  headline?: string;
  distance: Distance;
  pendingInvitation: boolean;
}

export class LinkedInClient {
  /**
   * `ownProviderId` is the connected account's own member id, stored on the connection at
   * connect time. Sending a DM needs it as the `mailboxUrn`. When it is absent (e.g. the
   * connect-time verification, which has no channel yet) `me()` resolves it lazily.
   */
  constructor(
    private readonly session: LinkedInSession,
    private ownProviderId?: string,
  ) {}

  private async ownUrn(): Promise<string> {
    if (!this.ownProviderId) this.ownProviderId = (await this.me()).providerId;
    return fsdProfileUrn(this.ownProviderId);
  }

  /** Who the session belongs to. The connect flow calls this to prove a pasted cookie works. */
  async me(): Promise<Me> {
    const res = await voyagerFetch(this.session, E.ME);
    const body = await voyagerJson<MeBody>(res, "me");
    const mini = body.included?.find((x) => x?.$type === "com.linkedin.voyager.identity.shared.MiniProfile")
      ?? (body.miniProfile as MiniProfile | undefined);
    if (!mini?.entityUrn) throw new Error("LinkedIn me() returned no profile");
    return {
      providerId: mini.entityUrn,
      publicIdentifier: mini.publicIdentifier ?? "",
      firstName: mini.firstName ?? "",
      lastName: mini.lastName ?? "",
    };
  }

  /**
   * A member's profile by the slug in their URL. This is the one call that turns a LinkedIn
   * URL into a provider id and tells us the network distance, which decides whether a DM is
   * allowed at all. It counts as a profile view against LinkedIn's daily cap, so the send
   * path caches the result and only calls it when the id is not already on the person.
   */
  async profileBySlug(publicId: string): Promise<Profile> {
    const res = await voyagerFetch(this.session, E.PROFILE_NETWORKINFO(publicId));
    const net = await voyagerJson<NetworkInfo>(res, "profile networkinfo");
    // networkinfo gives distance + pending flag but not always the name/urn, so pull the
    // mini profile too. Both are one view between them as far as the cap is concerned.
    const viewRes = await voyagerFetch(this.session, E.PROFILE_VIEW(publicId));
    const view = await voyagerJson<ProfileViewBody>(viewRes, "profileView");
    const mini = view.included?.find((x) => x?.$type === "com.linkedin.voyager.identity.shared.MiniProfile" && x.publicIdentifier === publicId)
      ?? view.included?.find((x) => x?.$type === "com.linkedin.voyager.identity.shared.MiniProfile");
    if (!mini?.entityUrn) throw new Error(`LinkedIn profile ${publicId} not found`);
    return {
      providerId: mini.entityUrn,
      publicIdentifier: mini.publicIdentifier ?? publicId,
      firstName: mini.firstName ?? "",
      lastName: mini.lastName ?? "",
      headline: mini.occupation,
      distance: net.distance?.value ?? "OUT_OF_NETWORK",
      pendingInvitation: Boolean(net.distance?.value === "DISTANCE_2" && net.following === false && net.pendingInvitation),
    };
  }

  // ── write ops ──

  /**
   * Send a connection invitation with an optional note. CONFIRMED shape (2026-09-17).
   *
   * The invite targets an fsd_profile urn; `me()`/`profileBySlug()` hand back an
   * fs_miniProfile urn with the same opaque id, so it is rewritten. The note is
   * `customMessage`, capped at 300 characters (LinkedIn rejects longer; free accounts are
   * held to 200 — the channel's maxBodyLength enforces the tighter one upstream).
   */
  async sendInvite(providerId: string, note?: string): Promise<{ invitationUrn: string }> {
    const body: Record<string, unknown> = {
      invitee: { inviteeUnion: { memberProfile: fsdProfileUrn(providerId) } },
    };
    if (note && note.trim()) body.customMessage = note.trim().slice(0, 300);
    const res = await voyagerFetch(this.session, E.INVITATION_CREATE, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    const data = await voyagerJson<unknown>(res, "invite");
    // The created invitation's urn, best-effort: the decorated response carries it, but the
    // exact field moves, so pull the first invitation urn out of the body. Absent is fine —
    // withdraw resolves the id from the sent-invitations list when it needs it.
    const urn = JSON.stringify(data).match(/urn:li:fsd_invitation:\d+|urn:li:invitation:\d+/)?.[0] ?? "";
    return { invitationUrn: urn };
  }

  async withdrawInvite(_invitationUrn: string): Promise<void> {
    throw new Error("withdrawInvite: confirm against a live session before enabling");
  }

  /** First-degree connections, recent first — poll this to detect an accepted invite. MED. */
  async relations(_start = 0, _count = 40): Promise<Array<{ providerId: string; connectedAt?: number }>> {
    throw new Error("relations: confirm RELATIONS shape against a live session before enabling");
  }

  /**
   * Send a direct message, starting the conversation if there isn't one. CONFIRMED
   * (2026-09-17). `providerId` is the recipient; `mailboxUrn` is our own account. LinkedIn
   * reuses the existing 1-to-1 conversation when one already exists, so `hostRecipientUrns`
   * covers both a first DM and a later one — `conversationUrn` is accepted but unused.
   *
   * The body goes as `text/plain`, which is what LinkedIn's own client sends here. The
   * `originToken` (a UUID) and `trackingId` (16 random bytes) are per-message client ids;
   * `dedupeByClientGeneratedToken:false` means LinkedIn does not collapse repeats, so the
   * send path must not retry a message it already delivered.
   */
  async sendMessage(providerId: string, text: string, _conversationUrn?: string): Promise<{ conversationUrn: string }> {
    const body = {
      message: { body: { attributes: [], text }, originToken: randomUUID(), renderContentUnions: [] },
      mailboxUrn: await this.ownUrn(),
      trackingId: randomBytes(16).toString("binary"),
      dedupeByClientGeneratedToken: false,
      hostRecipientUrns: [fsdProfileUrn(providerId)],
    };
    const res = await voyagerFetch(this.session, E.MESSAGE_CREATE, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await voyagerJson<unknown>(res, "message");
    const conversationUrn =
      JSON.stringify(data).match(/urn:li:msg_conversation:[^"]+|urn:li:fsd_conversation:[^"]+/)?.[0] ?? "";
    return { conversationUrn };
  }

  /**
   * Comment on a post, or reply to a comment. CONFIRMED (2026-09-17).
   *
   * A reply is the same call as a comment — there is no separate parent field. The only
   * difference is the target: a comment's `threadUrn` is the post's activity urn
   * (`urn:li:activity:<id>`); a reply's `threadUrn` is the parent comment's own urn
   * (`urn:li:comment:(activity:<postId>,<commentId>)`). So `parentCommentUrn`, when given,
   * simply replaces the target.
   *
   * (LinkedIn's UI also seeds a reply with an @-mention of the comment author, carried in
   * `attributesV2`. A plain reply needs none, so this sends text only; mentions are a later
   * feature.)
   */
  async comment(threadUrn: string, text: string, parentCommentUrn?: string): Promise<{ commentUrn: string }> {
    const target = parentCommentUrn ?? threadUrn;
    const body = {
      commentary: { text, attributesV2: [], $type: "com.linkedin.voyager.dash.common.text.TextViewModel" },
      threadUrn: target,
    };
    const res = await voyagerFetch(this.session, E.COMMENT_CREATE, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    const data = await voyagerJson<unknown>(res, "comment");
    const commentUrn = JSON.stringify(data).match(/urn:li:fsd_comment:[^"]+|urn:li:comment:\([^)]+\)/)?.[0] ?? "";
    return { commentUrn };
  }
}

// ── Voyager response shapes (only the fields we read) ──

/**
 * Rewrites any form of a member id to the fsd_profile urn the write endpoints expect.
 *
 * `me()` and `profileBySlug()` return `urn:li:fs_miniProfile:ACoAA…`; invites and messages
 * want `urn:li:fsd_profile:ACoAA…`. The opaque id (`ACoAA…`) is the same in both, so this
 * takes whatever is stored — a full urn of either kind, or a bare id — and returns the
 * fsd_profile form.
 */
export function fsdProfileUrn(providerId: string): string {
  const id = providerId.includes(":") ? providerId.slice(providerId.lastIndexOf(":") + 1) : providerId;
  return `urn:li:fsd_profile:${id}`;
}

interface MiniProfile {
  $type?: string;
  entityUrn?: string;
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  occupation?: string;
}
interface MeBody {
  miniProfile?: MiniProfile;
  included?: MiniProfile[];
}
interface ProfileViewBody {
  included?: MiniProfile[];
}
interface NetworkInfo {
  distance?: { value?: Distance };
  following?: boolean;
  pendingInvitation?: boolean;
}
