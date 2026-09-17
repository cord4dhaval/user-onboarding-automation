# LinkedIn channel: end-to-end build plan

Date: 2026-09-17

## What this is

The engine becomes its own Unipile for LinkedIn. Each product on the engine (TeamGrid is
one of several) can connect LinkedIn accounts. The engine stores each account's browser
session cookie encrypted, and calls LinkedIn's internal web API (the "Voyager" API that
linkedin.com's own single-page app calls) to send messages, send connection invitations,
comment on posts and reply to comments. No third-party vendor sits in between.

This channel is built for a user acting on their own LinkedIn account. It automates
activity that LinkedIn's User Agreement (section 8.2) does not permit, so the account risk
sits with whoever connects. That risk is surfaced at connect time and kept low with tight
pacing. The engine does not solve captchas or defeat bot detection; the user logs in
themselves in their own browser, which is where a valid session and user agent come from.

## The mechanism, in one picture

```
user signs in to LinkedIn in their own browser
      |
      v
extension / paste grabs the session:  li_at, JSESSIONID, the browser user agent
      |
      v
engine seals them with sealSecret() and stores one credential row per account
      |
      v
at send time the engine decrypts, sets the cookies + csrf-token + user agent,
and calls the Voyager endpoint for the action
      |
      v
messages / invites / comments / replies go out as that user
incoming replies arrive over a realtime stream or a poll
```

## Session facts that drive the design

- The session is the cookie `li_at` plus `JSESSIONID`. The `csrf-token` request header must
  equal the `JSESSIONID` value (LinkedIn's own SPA does this). Requests also need a stable
  user agent that matches the browser the cookie came from, and a stable egress IP/country;
  a mismatch is the fastest way to get the session invalidated.
- Voyager base is `https://www.linkedin.com/voyager/api/...`. Messaging moved to a GraphQL
  endpoint (`/voyager/api/graphql` and `/voyager/api/voyagerMessagingGraphQL/graphql`) with
  rotating query ids; REST "dash" paths cover the rest.
- A dead session shows up as HTTP 401, or a redirect/challenge to `/checkpoint` or
  `/uas/login`. Restriction and rate limiting show up as HTTP 429 and HTTP 999. These are
  the signals the health check and the send path key on.
- LinkedIn rotates the query ids used by the GraphQL calls and occasionally renames dash
  paths. So the endpoint constants live in one file behind the client and are treated as
  config that can change without touching the engine. The exact current ids are read from a
  live logged-in session (the browser Network tab) at build time, not guessed here.

## Where this lands in the existing code

The audit found most of the plumbing already present. `linkedin` is already a `channelKey`
(`src/schemas/common.ts:11`), a person identity kind (`src/schemas/person.ts:37`) and an
address mapping (`src/engine/address.ts:12`). What is missing: a catalogue entry, an
adapter, a connect flow, cookie storage wiring, session health, inbound handling, action
subtypes, tuned limits, and UI. The channel is modelled the same way Gmail is: one
connection per connected account, one channel (sender) on it, secret in the credential
collection under envelope encryption.

### New auth type and transport

- `src/schemas/common.ts` — add `"cookie"` to the `authType` enum.
- `src/channels/catalog.ts` — add a `cookie`/`session` transport to `TRANSPORTS` and a
  `linkedin` entry to `CHANNEL_CATALOG` (channelKey `linkedin`, one transport).

### The session client (new)

`src/adapters/channel/linkedin/` — a small `fetch` client, no SDK. Files:

- `endpoints.ts` — every Voyager path and GraphQL query id as named constants, in one
  place, so a LinkedIn change is a one-file edit. Documented as "read these from a live
  session; they rotate."
- `session.ts` — builds headers from the decrypted cookie: `cookie`, `csrf-token`
  (= JSESSIONID), `x-restli-protocol-version: 2.0.0`, `x-li-lang`, the stored user agent,
  the right `accept`. Persists any refreshed cookie returned in `Set-Cookie`. Classifies a
  response into `ok | expired | restricted | rate_limited | error`.
- `client.ts` — one method per capability: `me()`, `profileBySlug()`, `sendInvite()`,
  `withdrawInvite()`, `sentInvites()`, `relations()`, `listConversations()`,
  `listMessages()`, `sendMessageInConversation()`, `startConversation()`, `markRead()`,
  `listPosts()`, `getPost()`, `listComments()`, `comment()`, `replyToComment()`,
  `react()`. Each returns typed data or throws a classified error.

### The channel adapter (new)

`src/adapters/channel/linkedin.ts` — implements the `ChannelAdapter` interface
(`src/adapters/channel/types.ts`). Because a LinkedIn action is not one shape, the adapter
reads a new `op` from the outbound message and dispatches: invite, message, comment, reply.
Requires new fields on `OutboundMessage` (see below).

### OutboundMessage and action subtype

- `src/adapters/channel/types.ts` — add optional LinkedIn fields to `OutboundMessage`:
  `op?: "invite" | "message" | "comment" | "reply"`, `providerId?` (the target member),
  `note?`, `postUrn?`, `parentCommentUrn?`, `conversationUrn?`.
- `src/schemas/action.ts` — add `action.linkedin { op, note?, invitationUrn?,
  conversationUrn?, commentUrn? }` and a `pending_accept` action status so an invite can
  wait for acceptance instead of resolving on a reply or a timeout.

### Credential resolution

- `src/crypto/broker.ts` — a cookie credential decrypts and returns the session blob; it is
  not a refreshable OAuth token, so it takes the "static key just decrypts" path. On a
  classified `expired` from the client, mark the credential `expired` and the connection
  `degraded` (same pattern the Gmail refuse path already uses).

### Send path

- `src/engine/adapters.ts` — a `provider === "linkedin"` branch that builds the LinkedIn
  adapter with the resolved session.
- `src/engine/fireDue.ts` — LinkedIn gates: no HTML, no subject, no unsubscribe, no
  tracking; resolve the person's provider id (from cache, else one profile lookup) just
  before sending; the address label becomes "no LinkedIn profile"; the outbound `vars`
  carry the LinkedIn identity.
- `src/engine/validate.ts` — LinkedIn rules: invite note <= 300 chars (200 on a free
  account), no subject/opt-out requirement, DM only when the target is a 1st-degree
  connection, else defer with reason "not connected yet".
- `src/engine/compose.ts` — `toOutbound` passes the new LinkedIn fields.
- `src/engine/reconcile.ts` — a `pending_accept` invite is resolved by the acceptance
  signal (webhook/poll), not by `checkStatus`.
- `src/engine/channels.ts` — a separate assigned sender per channel kind, so a LinkedIn
  step does not overwrite the person's email mailbox and break the email thread.

### Limits (LinkedIn caps are far tighter than email)

`src/engine/governor.ts` — add a weekly window and per-action-type limits, plus randomized
spacing and a warm-up ramp. Starting envelope per account, rising weekly:

```
action         start/day   max/day   max/week
invite         10          30        100
message        20          50        --
comment/reply  10          30        --
profile view   30          80        --
spacing        random 2-9 min between actions
```

### Inbound

- New route `app/api/linkedin/webhook/route.ts` if we run a realtime listener that posts to
  us; otherwise a poller in the tick. Given LinkedIn has no push to third parties, the
  realtime stream (`realtime/connect` SSE) must be held open by a worker, or we poll
  conversations every few minutes at random. Decision below.
- New messages become `events` rows `type: "reply_received"`, matched to a person by
  LinkedIn provider id (add the id to the `identity_lookup` index).
- `src/engine/replyIntents.ts` — automatic replies go out on LinkedIn, not the email
  fallback, when the inbound was LinkedIn.
- `src/engine/reach.ts` — count LinkedIn as a channel whose replies can be read, so it does
  not raise the false "replies can't be read" notice.
- `src/engine/unsubscribe.ts` / `suppression.ts` — a LinkedIn opt-out suppresses the
  LinkedIn identity, not just an email string.

### Acceptance and comments (the two things LinkedIn cannot push)

- Invite acceptance: poll sent invites + relations a few times a day at random. When a
  target moves to 1st-degree, resolve the `pending_accept` action and queue the DM.
- Comments on our own posts: no webhook exists. Poll our recent posts' comments at random
  times, newest first; a new comment becomes a `comment_received` event and a draft reply
  in Review.

### Identity capture

- `src/engine/spreadsheet.ts`, `src/adapters/source/audience.ts`, import paths in
  `app/actions.ts` — read a LinkedIn profile URL column. Store
  `person.linkedin { slug, providerId, degree, checkedAt }`; provider id and degree are
  filled on first lookup and cached.

### UI

`app/products/[id]/channels/` — a LinkedIn tile, a connect drawer that shows the account
risk and a consent tick and collects the session (extension or paste), a reconnect button
(same pattern as `reconnect-google.tsx`), and the health reason on the row. `channel-
settings.tsx` key list, `channel-fields.tsx`, `templates/template-drawer.tsx`,
`goals/goal-drawer.tsx`, `library/[personId]/page.tsx` (invite/accept/DM state per lead),
`review/page.tsx` (LinkedIn drafts, "public" badge for comments).

### Cron

`app/api/cron/tick/route.ts` — a LinkedIn step that runs the acceptance poll and the
comment poll on their own randomized cadence (not every minute), plus a health refresh.

### Deleting a channel

`app/actions.ts` — deleting the channel deletes the stored session credential. There is no
vendor account to also delete now.

## How the session gets in

Two options; pick one for the first build.

1. Chrome extension (what Unipile's cleanest path does): the user clicks "connect" in the
   extension while logged in, it reads the cookies and user agent and posts them to a
   one-time link. Cleanest UX, most to build.
2. Manual paste: the user pastes `li_at` (and we derive JSESSIONID by making one request)
   plus their user agent. Ugly but zero extension work, good enough to test the whole
   engine flow with one account.

Recommendation: build option 2 first to prove the channel end to end with one account, add
the extension later.

## Phases and the test

- **P1 Connect + session health.** authType `cookie`, catalogue entry, the session client's
  `session.ts` + `me()`, the connect drawer (paste), store the sealed session, health rule
  that flags expired/restricted, reconnect. Done when: connecting one account shows healthy
  and `me()` returns the right name; ending the session in LinkedIn settings flips the row
  to a reason and reconnect fixes it.
- **P2 Identity + limits.** LinkedIn URL on import, provider-id cache, the tuned governor
  with the weekly window and per-op limits. Done when: a sheet with LinkedIn URLs imports
  and a lead page shows the network degree.
- **P3 Invite -> accept -> DM.** action subtype + `pending_accept`, the adapter's invite and
  message ops, validate rules, the acceptance poll, email fallback after ~21 days. Done
  when: five real leads run invite, accept, DM with state and reason visible per lead.
- **P4 Inbound messages.** realtime/poll, reply events, LinkedIn replies answered on
  LinkedIn, LinkedIn opt-out suppression, reach fix. Done when: a real reply appears in
  Review as a draft in the same conversation.
- **P5 Comments.** a warm-up comment before the invite, the comment poll, reply drafts in
  Review with the post text and a public badge. Done when: a new comment on the owner's post
  gets a reply draft after one poll.
- **P6 Claude writes LinkedIn copy.** writingBrief LinkedIn section, action-type field in
  `compose_batch`, LinkedIn state in `lead_card`, routine prompt edits pushed to the remote
  triggers.

### Testing with one account

After P1-P3, connect one real LinkedIn account (a low-value one, the owner's own, on a paid
plan if possible), point a tiny campaign at 3-5 leads that have LinkedIn URLs, and watch:
connect -> healthy, invite sent -> pending_accept, acceptance detected -> DM sent, and every
step's reason visible on the lead page. Keep daily counts at the "start" column while
testing.

## Security and safety

- The session cookie is full access to that user's LinkedIn. Seal it with `sealSecret`,
  never return it from any MCP tool (the existing "Claude never sees a credential" rule),
  and log only that a session was used, not its value.
- Match the stored user agent and a stable country on every call, and persist refreshed
  cookies from `Set-Cookie`, or sessions die early.
- Endpoint constants and GraphQL query ids rotate; keep them in one file and expect to
  refresh them from a live session when LinkedIn changes them.
- The engine does not attempt captcha solving or bot-detection evasion; the user logs in
  themselves.

## Open decisions

1. Session capture for the first build: manual paste (recommended to start) or the Chrome
   extension.
2. Inbound: hold a realtime stream open with a worker, or poll conversations at random.
   Poll is simpler and fits the existing tick; the stream is faster but needs a long-lived
   process the current cron design does not have.
3. LinkedIn voice: short messages from the person's profile, without the "The TeamGrid Team"
   sign-off. This conflicts with the current no-names copy rule, which is email-specific.
4. Comments on leads' public posts carry the owner's name and are public. In or out.
```
