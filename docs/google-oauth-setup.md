# Connecting Gmail: Google Cloud setup, end to end

One OAuth client serves the whole deployment. Every customer who connects a mailbox
consents to that one client, so this is done once by whoever runs the app, not per tenant.

The order below matters. Scopes are declared before the client is created, because the
consent screen is what verification reviews, and the client is only the plumbing.

---

## 1. Project

1. <https://console.cloud.google.com/projectcreate>
2. Name it something a reviewer will recognise as your product — the project name shows up
   in the verification thread.
3. Note the project id.

## 2. Enable the Gmail API

**APIs & Services → Library → Gmail API → Enable.**
Nothing else needs enabling. Sending, reading and settings all live behind this one API.

## 3. Consent screen (Google Auth Platform → Branding)

| Field | What to put |
| --- | --- |
| App name | The product name customers will see above "wants access to your Google Account" |
| User support email | A monitored address, not a personal one |
| App logo | 120×120 PNG. Uploading one triggers brand review — expect that, it is normal |
| Application home page | A real page describing the product |
| Privacy policy URL | Must be reachable, must mention what you do with Gmail data |
| Terms of service URL | Optional but reviewers ask for it |
| Authorised domains | The bare domain, e.g. `teamgrid.ai` — no scheme, no path |
| Developer contact | Where Google emails you about verification |

**Audience:** *External* unless every mailbox you will ever connect is inside your own
Workspace, in which case *Internal* skips verification entirely.

## 4. Scopes

**Data access → Add or remove scopes**, then add exactly these:

| Scope | Buys | Google's class | Price of using it in production |
| --- | --- | --- | --- |
| `openid`, `email`, `profile` | Which account connected | — | Nothing |
| `.../auth/gmail.send` | Sending | Sensitive | Brand verification |
| `.../auth/gmail.modify` | Replies, bounce notices, labelling threads read | **Restricted** | Verification **plus** an annual CASA security assessment |
| `.../auth/gmail.settings.basic` | The mailbox's verified send-as aliases | **Restricted** | Same CASA assessment |

Restricted scopes are the expensive half. Two ways to sequence this:

- **Ship send-only first.** Set `GOOGLE_SCOPE_TIERS=identity,send` in `.env`. Brand
  verification alone unblocks production, and reply reading turns on later by widening the
  variable — though every already-connected customer must reconnect to grant the new scope.
- **Ask for everything now.** Keep the default `identity,send,read,manage`. Nothing is
  blocked while you are in testing mode, and no customer is ever asked to consent twice.

## 5. Test users

**Audience → Test users → Add.** Up to 100 addresses.

While the app is in *Testing*, those addresses can grant every scope above, restricted ones
included, with no verification and no assessment. This is the whole development and pilot
phase. The consent screen shows an "unverified app" warning that a test user clicks past
via **Advanced → Go to … (unsafe)**.

Refresh tokens issued in testing mode expire after 7 days. That is a property of testing
mode, not a bug in the connect flow — the mailbox goes `degraded` and needs reconnecting.
It stops once the app is published.

## 6. OAuth client

**Credentials → Create credentials → OAuth client ID → Web application.**

Authorised redirect URIs — add one line per environment, matched exactly, no trailing
slash:

```
http://localhost:3001/api/oauth/google/callback
https://your-app-domain/api/oauth/google/callback
```

Authorised JavaScript origins can stay empty; the flow is server-side.

Copy the id and secret into `.env`:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_SCOPE_TIERS=identity,send,read,manage
APP_URL=https://your-app-domain
```

Restart the app. The **Gmail** tab in Channels → Add channel goes live the moment both
variables are set.

## 7. Verify the domain

**Search Console → Add property → your domain**, verified by DNS TXT, using the same Google
account that owns the Cloud project. Authorised domains and the privacy policy URL are both
checked against this, and verification stalls silently without it.

## 8. Publish and get verified

**Audience → Publish app**, then follow the verification prompts.

What they ask for:

- A demo video (YouTube, unlisted is fine) showing the OAuth consent screen and then what
  the app does with the data each scope grants. This is the item most submissions get
  returned on — record the consent screen itself, not just the feature.
- A written justification per scope. "We send campaign email from the user's own mailbox and
  read replies to that mail so campaigns stop when someone answers" is the shape of it.
- For restricted scopes only: a **CASA Tier 2** assessment through an authorised assessor,
  repeated annually, at your own cost.

Rough timings: brand review days to two weeks; sensitive-scope verification two to six
weeks; CASA adds weeks more and involves scheduling with a third party. **Start the
submission the day the client is created** — the code is done long before the paperwork.

## 9. Prove it works

```bash
npm run gmail:check                 # every connected mailbox: scopes, token refresh, channel, inbound
npm run gmail:check -- you@example.com   # also sends one real message
```

The check goes through the same broker, adapter and poller the engine uses, so passing it
means a campaign will send.

---

## Limits you are now living inside

| | Consumer `@gmail.com` | Workspace |
| --- | --- | --- |
| Recipients per day, per mailbox | 500 | 2,000 |
| API messages per minute | ~30 sustained | ~30 sustained |
| Delivery webhooks | none | none |

The channel is created at 200/day, 10/min, 60/hour, all editable in its settings. Staying
under Google's ceiling is deliberate: crossing it fails *every* remaining send that day,
including the mailbox owner's own human mail.

Bounces and replies both arrive as mail rather than as callbacks, which is why reply reading
is not optional flavour — without `gmail.modify` a dead address keeps being mailed until the
campaign gives up on silence. Opens and clicks never come from Google at all; those are our
own pixel and signed redirector.

Scaling past a couple of thousand a day means more mailboxes, not a bigger quota — or an ESP
channel alongside this one for bulk, keeping Gmail for the one-to-one sends where coming
from a real person's mailbox is the entire point.

## When it goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `redirect_uri_mismatch` | The URI in the client does not match byte for byte | Check scheme, port, trailing slash, and that `APP_URL` matches the environment |
| Connect ends at `oauth_error=no_refresh_token` | Google only mints a refresh token on fresh consent, and this account had already consented | Remove the app at <https://myaccount.google.com/permissions> and connect again |
| `oauth_error=send_permission_declined` | The customer unticked a box on the consent screen | Reconnect and approve sending |
| Channel goes `degraded` after 7 days | Testing-mode refresh token expired | Publish the app, or reconnect |
| 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | Scopes were widened after the mailbox was connected | The customer reconnects; old grants do not gain new scopes |
| Sends stop mid-afternoon | Daily quota | Lower the channel's cap, or connect a second mailbox |
