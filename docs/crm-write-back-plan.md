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
| Email opened (by a person) | yes — once a day, not once per message |
| Link clicked | yes |
| Lead replied | yes — proposed, see open questions |
| Message planned, queued or waiting for approval | **no** |
| Send failed, bounced, skipped or held | **no** |
| Machine opens (mail gateway scans) | **no** |

A rep reading a lead should see a short list of real events. Anything that did not reach the
person is our problem, not theirs.

## What the live test proved (2026-09-24)

Run against Milan Bhimani (lead `6a9e5051dc4ae9197d2c70ec`, lost, every campaign of his
already ended). Four notes written, read back, and deleted again.

**The credential is not a blocker.** Every write tool warns "MAIN_ADMIN ONLY. Org API keys
cannot call this", but the key we already hold is one:

```
crm_add_note -> {"ok": true, "actor": {"userId": "68af27a4bcb678eca5866fb9",
                                       "email": "admin@teamgrid.com"},
                 "noteId": "6ab4cc68e7f352b7d37aa6e6"}
```

So no new credential is needed. What is still worth asking for is a **dedicated CRM user**
("TeamGrid Outreach"), because the lead page prints the author on every row and today that
would read `admin@teamgrid.com` — the admin account appearing to write about emails it never
sent. Its userId goes in `actorUserId`; nothing else changes.

**The loop is real.** Our own note came straight back on the timeline as
`NOTE_ADDED by System Administrator`, which our sync maps to kind `note`, which is in
`NEWS_KINDS`, which re-plans the lead's next message. Every note we write would rewrite the
mail that wrote it. The guard goes in first.

**The feed truncates at about 60 characters**, and the prefix eats 13 of them:

```
added note · Email sent — "Which rooftop job took the most design desk ho...
```

So we trim the subject ourselves, to 45 characters with an ellipsis, rather than letting the
cut land mid-word.

**An audit row cannot be taken back.** Deleting a note adds `NOTE_DELETED` beside the
`NOTE_ADDED`; both stay forever. Nothing is ever written to a live lead to try something out.

**Their AI reads this feed.** The lead page offers "Next suggested action — AI can recommend
what to do next on this lead", so our notes become evidence for their own suggestions. One
more reason every line is a fact and never a plan.

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
| Email opened | `Opened our email today` (first human open of the day, one line) |
| Link clicked | `Link clicked — {page} — from "{subject}"` |
| Reply | `Replied to our email — "{first 80 characters}"` |

`{page}` is read from the clicked URL: the sign-up page, the pricing page, the security page.

### What we will not call

`crm_change_lead_status`, `crm_update_lead`, `crm_move_lead`, `crm_create_lead`. Sales owns
those fields. `crm_set_follow_up` is out too, decided 2026-09-24: a note can be ignored, a
task has to be cleared, and a rep's to-do list is theirs to fill. An engine that moves a lead to "hot" because of an open will be wrong in public
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

Two switches, in two places, because they are two decisions.

```
connection  (Connections -> the CRM -> "Write our activity back")
  crm.write.enabled       the master switch, off by default
  crm.write.events        which of the six events may be written
  crm.write.actorUserId   who to write as, when their CRM takes one

campaign    (Campaigns -> Edit -> "Sales CRM")
  goal.crmWrite           whether this campaign's work is written
```

Master off writes nothing, whatever a campaign says. Master on writes for the campaigns
that ticked the box. The connection is the right home for "may this CRM be written to at
all", and the campaign for "should a rep see this work" — the same CRM holds leads worked
by campaigns a rep wants on their screen and campaigns they do not.

Today the three hot-lead campaigns write, so a lead's page shows their whole story across
email, WhatsApp and LinkedIn, and the 356 older July-August leads stay out until somebody
has read a week of the rest. An event that cannot name its campaign is not written rather
than guessed at. On the week this
was built, all of it on would have been 83 notes on the busiest day across 77 leads — about
one line per lead per day, and four minutes of their rate limit. The list is there to keep
the first week answerable, not because the volume is a problem.

## Size

About a day and a half once the credential exists: the write map, the queue kind and its
drain, the three trigger points, the loop guard, and the settings.

## Open questions

1. Do replies get a note, or does the sales team see them another way?

Decided on 2026-09-24: `admin@teamgrid.com` is fine as the author, so nothing is needed from
the sales team; and no follow-up task on a click.

With opens rolled up to one line a day, an active lead costs about eight notes a week
(Kusum Sagar Pathak's real week: six sends, one click, one open line) rather than thirteen.
