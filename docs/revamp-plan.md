# Revamp plan: teamgrid_leads_v2, 2026-09-14

Goal of the campaign, in plain terms: a person who filled the TeamGrid ad form creates an account on teamgrid.ai. Nothing else counts. Everything below serves that one goal, as fast as possible, and stops the moment it happens.

The learning behind it is in `docs/learnings.md` (Hormozi, Mailtrap, Roshan's SaaS lifecycle playlist). This file is the plan we execute.

## 1. Audit of what exists today

| Area | State on 2026-09-14 | Verdict |
|---|---|---|
| Leads | 43 people: founder 15, off_icp 13, unknown 6, eng_leader 3, agency_owner 3, hr_ops 2, 2 suppressed. 6 active in v2, 61 recycled from earlier campaigns | keep |
| Source | `teamgrid_leads` (MCP, BrandGrid) off since 2026-09-11, points at v2 | switch on after the revamp |
| Goal v2 | composeAll, 8 touches in 14 days, every send gated in Review, success `signed_up` | **check was empty until today**; fixed |
| Sending | `teamgrid@qikflips.com` and `teamgrid@qiksteals.com`, no display name; `teamgrid.ai` never used because its DNS has no Google SPF, no DKIM, no DMARC | move to `hello@teamgrid.ai` after the DNS records in section 3 |
| Tracking | clicks yes, opens no (legitimate-interest rule), replies yes | opens on for form leads |
| Temperature | fit only; every form lead starts cold, so cadence is 1–2 days and the call step never opens | form arrival = warm |
| Templates | 29 rows, 22 active; three generations stacked on each other (see section 2) | cut to 14 |
| Playbooks | 18: six for the dead v1 goal, six for the old signup goal, six for v2 | archive the twelve stale ones |
| Assets | six screenshots (tier D) and one booking access asset (tier A, calendar connected) | keep; add one give-first asset |
| Booking | `/api/book` with live Google Calendar slots, hand-over on booking | keep; open the call step to every lead |
| Routines | acquire, advance, react, close, maintain hourly; four retired rows still registered | delete retired rows |
| Results | 69 mails sent since 2026-09-03: about 50 were the rejected "your workspace is ready" copy; 6 new variant-B welcomes today; 3 clicks, 0 replies, 0 signups | the new flow has not really been tested yet |

## 2. Why there are 29 templates, and what stays

Three generations were never cleaned up:

1. **Onboarding draft, 2026-09-03.** Claude drafted a ladder for a signup campaign: `welcome`, `activation_nudge`, `value_proof`, `objection`, `last_call`, plus per-segment copies of `welcome`. Two of each survive as active or draft. None belong to the ad-lead flow.
2. **Rebuild, 2026-09-10.** New rungs for ad leads: `privacy_objection`, `monday_morning`, `book_call`, `replaces_tools`, `re_qualify`, a new `last_call`, and `welcome_signup` for people who sign up.
3. **Variants, 2026-09-11.** Welcome A, B and C, each also copied per segment: nine `welcome` rows, four `welcome_b`, two `welcome_c`.

What stays (14): welcome A (default + founder, agency_owner, hr_ops, eng_leader wording), welcome B (default), welcome C (default + hr_ops), `book_call`, `privacy_objection`, `monday_morning`, `replaces_tools`, `last_call`, `re_qualify`, `welcome_signup`. Everything else is archived: the 2026-09-03 rungs, the paused welcomes, the blank stub `welcome` (no subject, no body, still active), and the `welcome_b` segment copies that repeat the default text.

## 3. Sending from teamgrid.ai

`teamgrid.ai` mail is on Google Workspace (MX is Google), so `hello@teamgrid.ai` connects like the other mailboxes. Before the first send, three DNS records, or the mail lands in spam as it did before:

| Record | Name | Value |
|---|---|---|
| SPF (replace the existing one) | `teamgrid.ai` TXT | `v=spf1 include:_spf.google.com include:zcsend.in ~all` |
| DKIM | `google._domainkey.teamgrid.ai` TXT | the 2048-bit key from Google Admin: Apps, Google Workspace, Gmail, Authenticate email, Generate new record; then Start authentication |
| DMARC | `_dmarc.teamgrid.ai` TXT | `v=DMARC1; p=none; rua=mailto:dmarc@teamgrid.ai; adkim=r; aspf=r` |

Today's SPF only allows Zoho Campaigns (`zcsend.in`), there is no DKIM selector and no DMARC. After the records propagate: connect `hello@teamgrid.ai` on the channels page with the calendar tier, set the display name to "TeamGrid", start the daily cap at 50 and raise it weekly, then disable the two qik mailboxes for this product. Reply-to stays `hello@teamgrid.ai` so replies land where a person reads them.

## 4. The new flow

```
day 0   WELCOME     "Welcome to TeamGrid" — what it is in one line, three things you would
        < 5 min     see (the four-line morning story, hours by project, attendance filling
                    itself in), what it never does (screenshots, keystrokes), one ask:
                    start the 7-day trial. One sentence tailored to the segment.
day 1   PROOF       the morning story card (variant B)                 only if no click
day 2   NUMBER      "7 of 25 were working" + the privacy answer in two lines (variant C)
day 3   CALL        15-minute setup call, two live slots, every lead not only warm
day 5   COST        what timesheets and chasing cost today (replaces_tools)
day 7   LAST        honest close (last_call)

clicked the trial link, no account after 4 hours  →  "one step left" nudge, then the call
replied "call" / "sample" / a question            →  owner pinged the same minute, hand-over
signed up                                          →  campaign ends the same minute
off_icp                                            →  one re_qualify mail, then silence
```

Six touches in seven days instead of eight in fourteen. Every mail: under 200 words, one ask, opens on the reader's situation, signed "The TeamGrid team", a preview line and a PS written for that person.

## 5. Changes, end to end

### Content (templates and playbooks)
- Rewrite welcome A as the straight welcome above; keep B and C as the day-1 and day-2 mails with a `no_click` gate instead of `no_open`.
- Move `book_call` to day 3 with no temperature gate; the second ask (trial button) becomes the PS.
- Give every rung a `preheader` slot and a `ps` slot.
- Archive the fifteen stale templates and the twelve stale playbooks.
- Re-stamp the six active v2 plans from the new playbooks (touches are at 1, so `stampPlaybook` allows it).

### Engine
- Form and ad arrivals start warm (temperature term `arrival_intent`), so the cadence is half a day to a day and the call step is reachable.
- Open pixel on for legitimate-interest leads that arrived through a form (config flag on the source).
- Send-time window: land mails between 10:00 and 12:00 or 13:00 and 15:00 in the lead's timezone, inferred from the site's city or phone code; default Asia/Kolkata for this product.
- `preheader` and `ps` per touch in compose_batch, both in the skeleton; word cap on the slot (90) and the rendered mail (200); one CTA per template enforced in validation.
- Owner notification on `reply_received` and on the first click, from the engine, same tick; React routine every 15 minutes.
- Tested welcome variants send without the review gate; composed steps keep it for the first week, then the gate comes off.
- `clicked_no_signup` gate: a plan step that fires only when the trial link was clicked and no `signed_up` arrived within four hours.
- UTM parameters on every CTA (`utm_source=email&utm_campaign=teamgrid_leads_v2&utm_content=<template>`).
- Sunset rule: a lead the flow finished never re-enters from the source.

### Site (teamgrid.ai)
- `register_started` event from the register page (the `signed_up` call already exists), so the "one step left" nudge is real.
- Exit-intent form on the pricing page offering the four-line sample; objection pages for privacy and pricing that the mails can link to.

## 6. Three leads through the new flow

**Scenario 1, founder of a 40-person SaaS, work email.** Tuesday 09:05 IST she fills the form. 09:08 the welcome lands from `hello@teamgrid.ai`, subject "Welcome to TeamGrid", four lines on what she would see tomorrow morning, one button. She clicks at 09:40, reads the register page, leaves. 13:40 the engine sees the click without `signed_up` and sends the nudge: "one step left: the agent installs in five minutes; or reply 'call' and we do it with you". She signs up at 14:10. The register page reports `signed_up`; the campaign ends within the minute; nothing else is sent. The install campaign, a separate goal, takes over later.

**Scenario 2, head of operations at a 20-city services company, never clicks.** Day 0 welcome with the hr_ops sentence about attendance across sites. Day 1 the morning story. Day 2 the "21 of 25 in by ten" number with the two-line privacy answer. Day 3 the call mail with Thursday 11:00 and Friday 15:00 as live buttons. He replies "Thursday works". The reply reaches the inbox at `hello@teamgrid.ai`, the engine records it, pings the owner on Slack the same minute and hands the person over: no more automated mail. The booking page confirms the slot and the Meet invite goes out.

**Scenario 3, owner of a retail shop, personal email, off_icp.** Day 0 he gets one mail, `re_qualify`: what his business appears to do, why a tool about where a team's computer time goes may not fit, and one question, do most of his people work at a computer. He replies "not for us". The reply is classified as an explicit no, the person is suppressed, and nothing else is ever sent. If he never replies, the flow ends after that one mail.

## 7. Order of work

1. DNS records and the `hello@teamgrid.ai` connection (you), form-lead temperature and open pixel (engine). Half a day.
2. Welcome A rewrite, gates to `no_click`, call step at day 3, template and playbook clean-up, re-stamp plans. One day, reviewed in Templates before the source is switched on.
3. Preheader and PS slots, word cap, one-ask validation, UTM, owner notification, send window. Two days.
4. `register_started` on the site and the clicked-no-signup nudge. When the site team can.
5. Source on. Watch clicks, replies and signups per rung for a week; move composed steps off the review gate when the copy holds.
