# TeamGrid integration spec: registration events and account lookup

For the teamgrid.ai developer. Two small changes so our email engine knows, within a minute, when a lead from the ad form starts registering and when they finish. Today it cannot tell, so a person who signs up keeps receiving the sales sequence.

Owner on our side: the conversion engine (`user-onboarding-automation-oryc.vercel.app`). Questions go to Dhaval.

| Part | What you build | What it gives us |
|---|---|---|
| A | The register flow calls one URL when registration starts and one when the account is created | The sequence stops the minute somebody signs up; a "one step left" reminder for people who start and leave |
| B | One MCP tool, `find_account_by_email` | Signups by any route are caught, including people who never used our link |

Both are needed. A is instant but only works for people who arrive through our link. B catches everyone but runs on a schedule.

---

## Part A: registration events

### 1. The links we send

Every trial link in our emails looks like this:

```
https://teamgrid.ai/register?p=6aa3932001df806497fe7620&s=c84b1f2426025ec08d83106cd959a45b&utm_source=email&utm_medium=email&utm_campaign=teamgrid_leads_v3&utm_content=welcome
```

| Parameter | Meaning | How to treat it |
|---|---|---|
| `p` | Our id for the lead: 24 hexadecimal characters | Opaque. Store and send back unchanged. |
| `s` | A signature over `p` | Opaque. Store and send back unchanged. Do not try to validate it. |
| `utm_*` | Campaign and email that produced the click | For your analytics. Not needed for these calls. |

### 2. Keep `p` and `s` through the whole flow

Registration may involve Google sign-in, an email verification step, a second tab, or a page reload. `p` and `s` must survive all of them.

- When any page of the signup flow loads with `p` and `s` in the URL, save them in a first-party cookie named `tg_lead` (value `{"p":"…","s":"…"}`, path `/`, 7 days, `SameSite=Lax`) and in `sessionStorage`.
- Later steps read them from the cookie if the URL no longer has them.
- If a person arrives without `p` and `s` (an organic visitor), do nothing. Part B covers them.

### 3. The two events

| Event | When to send it | How often |
|---|---|---|
| `register_started` | The register page is shown to a person who has `p` and `s` (from the URL or the cookie) | Once per page view; repeats within a minute are ignored by us |
| `signed_up` | The account has been created successfully, confirmed by your server (after Google sign-in completes, or after email verification if an account is not created before it) | Once, at creation. Never before the account exists. |

### 4. The endpoint

```
GET  https://user-onboarding-automation-oryc.vercel.app/api/e/<event>?p=<p>&s=<s>
POST https://user-onboarding-automation-oryc.vercel.app/api/e/<event>?p=<p>&s=<s>
```

- `<event>` is `register_started` or `signed_up`.
- No body, no headers, no authentication. The signature in `s` is the authentication.
- CORS is open (`Access-Control-Allow-Origin: *`), so it can be called from the browser. It can equally be called from your server.

| Response | Meaning |
|---|---|
| `204 No Content` | Recorded |
| `404 Not Found` | `p` is not a valid id, `s` does not match `p`, or the lead no longer exists. Nothing to retry. |

A repeat of the same event for the same person within 60 seconds is dropped, so a refresh or a double submit is harmless. Do not put the email address or any other personal data in the URL.

### 5. Example (browser)

```js
// On every page of the signup flow
(function () {
  const url = new URL(window.location.href);
  const fromUrl = { p: url.searchParams.get("p"), s: url.searchParams.get("s") };
  if (fromUrl.p && fromUrl.s) {
    const value = encodeURIComponent(JSON.stringify(fromUrl));
    document.cookie = `tg_lead=${value}; path=/; max-age=${7 * 24 * 3600}; samesite=lax`;
    sessionStorage.setItem("tg_lead", JSON.stringify(fromUrl));
  }
})();

function tgLead() {
  const stored = sessionStorage.getItem("tg_lead");
  if (stored) return JSON.parse(stored);
  const match = document.cookie.match(/(?:^|; )tg_lead=([^;]+)/);
  return match ? JSON.parse(decodeURIComponent(match[1])) : null;
}

function tgEvent(name) {
  const lead = tgLead();
  if (!lead) return;
  const endpoint = `https://user-onboarding-automation-oryc.vercel.app/api/e/${name}` +
    `?p=${encodeURIComponent(lead.p)}&s=${encodeURIComponent(lead.s)}`;
  if (navigator.sendBeacon) navigator.sendBeacon(endpoint);
  else fetch(endpoint, { method: "POST", keepalive: true, mode: "no-cors" });
}

// Register page, on load
tgEvent("register_started");

// After your API confirms the account was created
tgEvent("signed_up");
```

If the account is created on the server (for example in a Google sign-in callback), call the same URL from the server with the `p` and `s` read from the `tg_lead` cookie on that request.

### 6. How to test

1. We send you a test link for a test lead.
2. Open it and check that the register page's network log shows `register_started` returning `204`.
3. Complete registration and check that `signed_up` returns `204`.
4. We confirm both events on the lead's page in our app, and that the test lead's sequence stopped.

---

## Part B: MCP tool `find_account_by_email`

### Why

Part A only knows about people who arrive through our link. Somebody who reads our email and later types teamgrid.ai into the browser, or registers on a phone, never sends `p` and `s`. Our engine asks the TeamGrid MCP server on a schedule whether each lead now has an account. None of the current tools can answer that: `search_employees` only searches the signed-in organisation, and `list_organizations` is main-admin only and returns no owner email or creation date.

### Access

- Available to the OAuth connection our engine already uses (scope `teamgrid:read`, the organisation-admin login we reconnected on 14 Sep 2026).
- Looks across all organisations, but returns only the minimal facts below, so it does not expose other customers' data.
- Rate limit of at least 120 calls per minute for this client.

### Definition

**Name:** `find_account_by_email`

**Description (shown to MCP clients):** "Whether a TeamGrid account exists for an email address, across all organisations. Exact, case-insensitive match on the login email. Returns only existence, creation time, organisation id and role; never names or other users."

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "email": { "type": "string", "maxLength": 254, "description": "Login email to look up. Trimmed and compared case-insensitively." }
  },
  "required": ["email"]
}
```

**Output** (a single JSON text content item):

When an account exists:

```json
{
  "exists": true,
  "active": true,
  "createdAt": "2026-09-14T09:12:04.000Z",
  "orgId": "68b2c559f43d78cbf207113b",
  "orgCreatedAt": "2026-09-14T09:12:04.000Z",
  "role": "owner"
}
```

When it does not:

```json
{ "exists": false }
```

| Field | Rule |
|---|---|
| `exists` | `true` if any user record has this login email, active or not |
| `active` | Whether that user can currently log in |
| `createdAt` | When the user record was created, ISO 8601 UTC |
| `orgId` | The organisation the user belongs to (the first one, if several) |
| `orgCreatedAt` | When that organisation was created; lets us tell a new signup from an existing customer |
| `role` | `owner`, `admin` or `member` |

**Errors:** an empty or malformed email returns `isError: true` with `{"error":"invalid_email"}`. No other data in any error.

### How we will use it

Once the tool is live we add a check to each campaign:

```json
{
  "key": "signed_up_account",
  "kind": "mcp",
  "tool": "find_account_by_email",
  "args": { "email": "$person.email" },
  "assert": "$.exists == true"
}
```

The engine fills `$person.email` with each lead's address and calls the tool for every lead still in a campaign on the verification schedule. A lead whose email returns `exists: true` is marked signed up and receives no more sales email. Later, `orgId` lets a post-signup flow ask the existing tools about that organisation (sessions recorded, teammates invited).

### Acceptance tests

| Input | Expected |
|---|---|
| An email you know has an account | `exists: true` with `createdAt` and `orgId` |
| The same email in upper case, with spaces around it | Same result |
| An email with no account | `{"exists": false}` |
| `""` | `isError: true`, `invalid_email` |
| A partial email, such as a first name | `{"exists": false}`: exact match only |

Response time under 500 ms. After deploying, reconnect is not needed on our side: we re-read the tool list and run the tests above against the live server.
