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
import { RetryableSendError } from "../types.js";

export interface Me {
  providerId: string; // urn:li:fs_miniProfile:ACoAAB... — the person's stable id
  publicIdentifier: string;
  firstName: string;
  lastName: string;
  /** Premium can add a note to every invite; a free account to three a month. */
  premium: boolean;
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
      premium: body.premiumSubscriber === true || body.data?.premiumSubscriber === true,
    };
  }

  /**
   * A member's profile by the slug in their URL — the call that turns a LinkedIn URL into a
   * provider id, which every send needs.
   *
   * LinkedIn removed the old REST profile endpoints (they now 410) and its web app resolves
   * the vanity slug to the member id server-side, in the profile page itself: the SPA only
   * ever fetches a profile by id afterwards. So the slug is resolved the same way — fetch
   * the `/in/<slug>/` document and read the `fsd_profile` id (and, where the page embeds it,
   * the network distance) out of the JSON LinkedIn ships inside the HTML.
   *
   * This counts as a profile view against LinkedIn's daily cap, so the send path caches the
   * result on the person and only calls it when the id is not already known.
   */
  async profileBySlug(publicId: string): Promise<Profile> {
    const res = await voyagerFetch(this.session, E.PROFILE_BY_IDENTITY(publicId));
    const body = await voyagerJson<GraphqlProfile>(res, "profile");

    // The normalized response lists every referenced object in `included`. The member we
    // asked for is the Profile whose publicIdentifier matches the slug; from it we read the
    // entityUrn (our provider id) and the display fields.
    // This queryId is the lean "resolve identity to id" one: `included` holds a single
    // Profile object carrying just its entityUrn (our provider id). Name and distance are
    // not in this response — a richer profile query would add them, but the id is all the
    // send path needs, so distance defaults to unknown (OUT_OF_NETWORK) and the ladder
    // invites first unless it already knows the lead is a 1st-degree connection.
    const included = Array.isArray(body.included) ? body.included : [];
    const profile = included.find(
      (x) => typeof x?.entityUrn === "string" && String(x.entityUrn).startsWith("urn:li:fsd_profile:"),
    );
    if (!profile?.entityUrn) {
      throw new Error(`LinkedIn returned no profile for "${publicId}" — the slug may be wrong or the queryId stale`);
    }
    const distance =
      (JSON.stringify(body).match(/"(DISTANCE_[123]|SELF|OUT_OF_NETWORK)"/)?.[1] as Distance | undefined) ??
      "OUT_OF_NETWORK";
    return {
      providerId: String(profile.entityUrn),
      publicIdentifier: profile.publicIdentifier ?? publicId,
      firstName: profile.firstName ?? "",
      lastName: profile.lastName ?? "",
      headline: profile.headline,
      distance,
      pendingInvitation: /"invitationState":"PENDING"|"pendingInvitation":true/.test(JSON.stringify(body)),
    };
  }

  /** Debug: the raw profile-by-identity response, for inspecting its shape. */
  async rawProfile(identity: string): Promise<unknown> {
    const res = await voyagerFetch(this.session, E.PROFILE_BY_IDENTITY(identity));
    return voyagerJson<unknown>(res, "profile-raw");
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
  async sendInvite(providerId: string, note?: string): Promise<{ invitationUrn: string; already: boolean }> {
    const body: Record<string, unknown> = {
      invitee: { inviteeUnion: { memberProfile: fsdProfileUrn(providerId) } },
    };
    if (note && note.trim()) body.customMessage = note.trim().slice(0, 300);
    const res = await voyagerFetch(this.session, E.INVITATION_CREATE, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    // "Already invited", "already connected" and "can't resend yet" are not failures — the
    // relationship is already where an invite would move it, so the touch is spent, not
    // wasted. The engine reads `already` to keep the lead moving rather than retrying.
    if (!res.ok) {
      const code = text.match(/"code":"([A-Z_]+)"/)?.[1] ?? "";
      // The account's own invite limit is back-pressure, not a done invite: counting it as
      // sent would mark a whole day's invites spent that never left.
      if (/CONNECTION_LIMIT|FUSE_LIMIT|WEEKLY_LIMIT/.test(code + text)) {
        throw new RetryableSendError("LinkedIn's invitation limit for this account is reached", 24 * 3600);
      }
      if (/CANT_RESEND_YET|ALREADY_INVITED|ALREADY_CONNECTED/.test(code + text)) {
        return { invitationUrn: "", already: true };
      }
      throw new Error(`LinkedIn invite answered HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    // The created invitation's urn, best-effort: the decorated response carries it, but the
    // exact field moves, so pull the first invitation urn out of the body. Absent is fine —
    // withdraw resolves the id from the sent-invitations list when it needs it.
    const urn = text.match(/urn:li:fsd_invitation:\d+|urn:li:invitation:\d+/)?.[0] ?? "";
    return { invitationUrn: urn, already: false };
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
  premiumSubscriber?: boolean;
  data?: { premiumSubscriber?: boolean };
}

interface GraphqlProfileNode {
  entityUrn?: string;
  publicIdentifier?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
}
interface GraphqlProfile {
  included?: GraphqlProfileNode[];
}
