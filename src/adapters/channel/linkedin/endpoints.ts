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
 * A member's profile by the slug in their URL, or by their member id. CONFIRMED queryId
 * (2026-09-17). The old REST `/identity/profiles/<slug>/profileView` and `/networkinfo`
 * paths now 410; the web app fetches profiles through this graphql query, keyed on
 * `memberIdentity`, which accepts either the slug (vanity) or the `ACoAA…` id. The response
 * carries the `fsd_profile` entityUrn (our provider id) and the network distance.
 *
 * The queryId rotates like the messaging ones — re-read it from a live session (filter
 * `voyagerIdentityDashProfiles`) when profile lookups start failing. LOW on the queryId.
 */
export const PROFILE_QUERY_ID = "voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a";
export const PROFILE_BY_IDENTITY = (identity: string) =>
  `${BASE}/graphql?includeWebMetadata=true&variables=(memberIdentity:${identity})&queryId=${PROFILE_QUERY_ID}`;

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

/**
 * First-degree connections. CONFIRMED (2026-09-18): the REST path still answers, with a
 * `Connection` per member carrying `createdAt` (when they connected, epoch ms) and an
 * `fs_relConnection:<id>` urn whose id is the member id. Newest first with
 * `sortType=RECENTLY_ADDED`; the accept check reads the first page of that.
 */
export const RELATIONS = `${BASE}/relationships/connections`;
export const RECENT_CONNECTIONS = (count: number) => `${RELATIONS}?count=${count}&start=0&sortType=RECENTLY_ADDED`;

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
