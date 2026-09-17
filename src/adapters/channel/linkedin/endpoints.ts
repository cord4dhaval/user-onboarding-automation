/**
 * Every LinkedIn internal ("Voyager") path and GraphQL query id lives here, in one file, so
 * that when LinkedIn changes one the edit is one line and never touches the engine.
 *
 * These are not a public API. They are the endpoints linkedin.com's own single-page app
 * calls, and LinkedIn rotates the GraphQL query ids and occasionally renames the REST
 * "dash" paths without notice. Treat every constant here as configuration read from a live
 * logged-in session (the browser Network tab), not as a stable contract.
 *
 * Confidence tags:
 *   HIGH   — stable for years, safe to rely on (me, profile view).
 *   MED    — correct shape, but the exact path has moved before; verify on first use.
 *   LOW    — the request body/query id rotates; MUST be confirmed against a live session
 *            before the write op that uses it is switched on.
 */

export const BASE = "https://www.linkedin.com/voyager/api";

/**
 * The voyager-web client version LinkedIn stamps on every call via the `x-li-track` header.
 * Write actions (invite, message, comment) can be rejected without a plausible one. It
 * rotates roughly weekly — read a current value from a live session's `x-li-track` header
 * and update it here when writes start failing with a version complaint. LOW.
 */
export const CLIENT_VERSION = "1.13.46685";

/** Reading who the session belongs to. HIGH. */
export const ME = `${BASE}/me`;

/**
 * A member's profile by the slug in their URL (linkedin.com/in/<slug>). HIGH.
 * Returns the fsd_profile / miniProfile entityUrn we need as the person's provider id, plus
 * the network distance (1st / 2nd / 3rd) that decides whether a DM is even allowed.
 */
export const PROFILE_VIEW = (publicId: string) =>
  `${BASE}/identity/profiles/${encodeURIComponent(publicId)}/profileView`;

/** The leaner networkinfo call: just distance + a pending-invitation flag. MED. */
export const PROFILE_NETWORKINFO = (publicId: string) =>
  `${BASE}/identity/profiles/${encodeURIComponent(publicId)}/networkinfo`;

/**
 * Connection invitation. CONFIRMED against a live session 2026-09-17.
 *
 * POST with body {invitee:{inviteeUnion:{memberProfile:"urn:li:fsd_profile:<id>"}},
 * customMessage?:"<note>"}. The note field is `customMessage`, and the target is an
 * fsd_profile urn — not the fs_miniProfile urn `me()` returns, though the opaque id inside
 * is the same (see fsdProfileUrn in client.ts).
 */
export const INVITATION_CREATE = `${BASE}/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2`;
export const INVITATION_SENT = `${BASE}/relationships/sentInvitationViewsV2`;
export const INVITATION_WITHDRAW = (invitationUrnId: string) =>
  `${BASE}/voyagerRelationshipsDashMemberRelationships/${encodeURIComponent(invitationUrnId)}`;

/** First-degree connections, recent first — used to detect an accepted invite. MED. */
export const RELATIONS = `${BASE}/relationships/connections`;

/**
 * Messaging moved to GraphQL around 2023. The query ids below are the thing that rotates
 * most often; every one MUST be read from a live session before use. The values here are
 * placeholders that will 400 until replaced.
 *
 * How to read them: open messaging on linkedin.com with the Network tab filtering on
 * "graphql", and copy the `queryId` query-string value off each request.
 */
export const GRAPHQL = `${BASE}/graphql`;
export const MESSAGING_GRAPHQL = `${BASE}/voyagerMessagingGraphQL/graphql`;
export const QUERY_IDS = {
  /** LOW placeholders — replace from a live session. */
  conversations: "messengerConversations.PLACEHOLDER",
  messages: "messengerMessages.PLACEHOLDER",
} as const;

/**
 * Sending a message. CONFIRMED (2026-09-17): POST as `text/plain;charset=UTF-8` with body
 * {message:{body:{attributes:[],text}, originToken, renderContentUnions:[]}, mailboxUrn:
 * "<own fsd_profile urn>", trackingId, dedupeByClientGeneratedToken:false,
 * hostRecipientUrns:["<recipient fsd_profile urn>"]}. `hostRecipientUrns` starts (or reuses)
 * the conversation, so no conversationUrn is needed for a first DM.
 */
export const MESSAGE_CREATE = `${BASE}/voyagerMessagingDashMessengerMessages?action=createMessage`;

export const MARK_READ = (conversationUrn: string) =>
  `${BASE}/voyagerMessagingDashMessengerConversations/${encodeURIComponent(conversationUrn)}`;

/** A member's recent posts/activity by profile urn. MED. */
export const MEMBER_POSTS = (profileUrn: string) =>
  `${BASE}/identity/profileUpdatesV2?profileUrn=${encodeURIComponent(profileUrn)}&count=20`;

/**
 * Creating a comment. CONFIRMED (2026-09-17): POST with body {commentary:{text, attributesV2:
 * [], $type:"…TextViewModel"}, threadUrn:"urn:li:activity:<id>"}. A reply adds a parent field
 * whose exact name is confirmed from a reply capture.
 */
export const COMMENT_CREATE = `${BASE}/voyagerSocialDashNormComments?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-43`;
/** Listing comments on a post. MED — read path, confirm when comment polling is built. */
export const COMMENTS = (threadUrn: string) =>
  `${BASE}/voyagerSocialDashComments?q=comments&threadUrn=${encodeURIComponent(threadUrn)}&sortOrder=REVERSE_CHRONOLOGICAL`;

/** Reactions on a post or a comment. LOW. */
export const REACTION_CREATE = `${BASE}/voyagerSocialDashReactions`;
