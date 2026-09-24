# Writing our outreach back into the TeamGrid CRM

Today the CRM sync only reads. The sales team can see what they did with a lead and nothing
about what our campaigns did, so a rep calls someone who opened three of our emails last week
without knowing it, and writes "not interested" on a lead who clicked the pricing page an hour
earlier.

This plan puts our side of the story into the CRM as lead notes.

## The rule

Write only what happened and mattered. Never write plans, and never write failures.

| Event | Note written |
| --- | --- |
| Email sent | yes |
| WhatsApp message sent | yes |
| LinkedIn request or message sent | yes |
| Email opened (by a person) | yes |
| Link clicked | yes |
| Lead replied | yes — proposed, see open questions |
| Message planned, queued or waiting for approval | **no** |
| Send failed, bounced, skipped or held | **no** |
| Machine opens (mail gateway scans) | **no** |

A rep reading a lead should see a short list of real events. Anything that did not reach the
person is our problem, not theirs.

## What blocks it today

Every write tool on the TeamGrid MCP server begins:

> MAIN_ADMIN ONLY. Org API keys cannot call this.

Our connection uses an org API key. Before any of this runs we need two things from TeamGrid:

1. A **MAIN_ADMIN credential** for the outreach engine, stored as its own secret
   (`crm.write`, separate from the read key `crm.sync`).
2. A **user id for the writer** — a CRM user such as "TeamGrid Outreach" — passed as
   `actorUserId` on every call. Every note then shows who wrote it, and we can filter our own
   notes back out when reading.

Without the second one, our notes come back through the sync as team activity, re-plan the
lead's next email, and the system writes to itself in a loop.

## The calls

### A note on a lead

```json
{
  "tool": "crm_add_note",
  "args": {
    "leadId": "6aa77cabd27593b60b77c059",
    "body": "Email sent — \"Welcome to TeamGrid\"",
    "pinned": false,
    "actorUserId": "<outreach user id>",
    "orgId": "68b2c559f43d78cbf207113b"
  }
}
```

`leadId` is already on our side: `crm_links.externalId`. `orgId` is the one the sync uses
(`crm.map.scope.orgId`).

### Note bodies, exactly

| Event | Body |
| --- | --- |
| Email sent | `Email sent — "{subject}"` |
| WhatsApp sent | `WhatsApp message sent — "{first 60 characters}"` |
| LinkedIn invite | `LinkedIn connection request sent` |
| LinkedIn message | `LinkedIn message sent — "{first 60 characters}"` |
| Email opened | `Email opened — "{subject}"` |
| Link clicked | `Link clicked — {page} — from "{subject}"` |
| Reply | `Replied to our email — "{first 80 characters}"` |

`{page}` is read from the clicked URL: the sign-up page, the pricing page, the security page.

### A follow-up for the rep (proposed, off by default)

When a lead clicks or replies, our engine knows something the CRM does not. One call turns
that into a task on the rep's list:

```json
{
  "tool": "crm_set_follow_up",
  "args": {
    "leadId": "6aa77cabd27593b60b77c059",
    "scheduledAt": "2026-09-25T04:00:00.000Z",
    "scheduledTimezone": "Asia/Kolkata",
    "actorUserId": "<outreach user id>",
    "orgId": "68b2c559f43d78cbf207113b"
  }
}
```

### What we will not call

`crm_change_lead_status`, `crm_update_lead`, `crm_move_lead`, `crm_create_lead`. Sales owns
those fields. An engine that moves a lead to "hot" because of an open will be wrong in public
the first week, and the team will stop trusting everything else it writes.

## How it runs

```
message sent / opened / clicked
        |
        v
  work queue, kind "crm_note"          subjectId = "<actionId>:<event>"
        |                              the queue already refuses a duplicate subject,
        |                              so one event can never be written twice
        v
  minute tick drains it, 3 seconds between calls
        |
        v
  crm_add_note(...)  ->  stamped on the action, never retried after success
```

Three trigger points in the code:

| Where | When |
| --- | --- |
| `engine/fireDue.ts` | a send that returned success, per channel |
| `engine/tracking.ts` | first human open, first click |
| `engine/inbound.ts` | a reply we recorded |

Rate limit: the CRM shares one limit with production, so the queue spaces calls three seconds
apart, the same as the read sync.

## The loop guard

`engine/crm/sync.ts` reads notes and timeline events as news, and news re-plans a lead's next
message. Our own notes must be invisible to it:

- skip any activity whose author is the outreach user id;
- never store them in `crm_activity` as team context;
- never let them stamp `people.newsAt`.

This goes in before the first note is written, not after.

## Settings

Per connection, so another product can choose differently:

```
crm.write.enabled     false by default
crm.write.events      ["email_sent", "whatsapp_sent", "linkedin_sent", "opened", "clicked", "replied"]
crm.write.actorUserId the outreach user in their CRM
```

## Size

About a day and a half once the credential exists: the write map, the queue kind and its
drain, the three trigger points, the loop guard, and the settings.

## Open questions

1. Do replies get a note, or does the sales team see them another way?
2. Is a follow-up on a click welcome, or does it clutter their task list?
3. Do they want one note per email, or one digest note a week? One note per event is what
   this plan does; the volume is roughly 12 notes per lead per week on our current pace.
