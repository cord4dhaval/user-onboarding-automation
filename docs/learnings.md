# Learnings log

A running record of every brainstorm and outside source we study for the outbound engine: what the source says, what the engine does today, what we decided to take from it, and where that stands. One section per source, newest at the bottom. The merged backlog at the end is the single list to pick work from.

Status values: `todo`, `doing`, `done`, `skip` (with a reason).

---

## 2026-09-14 — Alex Hormozi, "Learn Email Marketing in 39 Minutes"

Source: https://www.youtube.com/watch?v=pLhQOYMGa88 (39 min, English; transcript pulled and read in full).

Context: Hormozi describes a subscriber newsletter ("Mozi Money Minute", three sends a week, opt-in list). Our engine runs a cold outbound sequence to ad leads over 14 days. Most tactics transfer; the cadence and "keep emailing forever" points transfer as a separate nurture stream, not as changes to the sequence.

### Already covered by the engine

- One-click unsubscribe (`List-Unsubscribe` + `List-Unsubscribe-Post` headers in the Gmail adapter) and an opt-out block on every mail.
- Consistent template skeleton per rung (subject, preheader, heading, fixed lines, slot, CTA, sign-off, opt-out).
- Segmentation: founder, agency_owner, hr_ops, eng_leader, off_icp, each with its own playbook and template pools.
- "One idea per message and one link" in the product voice; forbidden claims list; "no just checking in".
- Cadence bands by temperature and a 5-touches-per-week cap.
- Welcome variants A/B/C picked per person by Thompson sampling, graded after 48 hours of silence.

### Gaps and what to build

| # | Video tactic | Engine today | Build | Status |
|---|---|---|---|---|
| 1 | Speed to lead: contact within 60 s (Harvard study, +391% sales) | Source polled every 2 min, tick every minute, then `gate_on` holds the welcome for human approval, so minutes to hours | Webhook push source for the lead form; auto-send tested welcome variants and gate only composed steps; target under 5 min | todo |
| 2 | Reply fast, same reason | Replies are read by the React routine hourly (about :36); nobody answers for up to an hour | Engine pings the owner (Slack or mail) on `reply_received` in the same tick; auto-acknowledge template for "call" and "sample" intents; React every 15 min | todo |
| 3 | Send time: B2B opens best on Wednesday; 10–12 and 13–15 local; not first thing in the morning | Only quiet hours 21–08; `person.timezone` defaults to UTC so Indian leads are mailed at odd hours; no weekday logic | Infer timezone at enrichment (site city, phone code); snap `dueAt` into local windows; prefer Wednesday for B2B; keep cadence gaps | todo |
| 4 | Look like a normal one-to-one email: text, one or two links, no images, no money words, so it stays out of the Promotions tab | Templates render heading, cards, screenshots and a button; no spam-word check | `format: plain` per campaign or band (cold = paragraphs plus one text link); spam and money-word check in validation | todo |
| 5 | Preview text optimised (+24% opens; one in four reads it before opening) | Preheader is the template fallback; compose_batch touches carry a subject only | `preheader` per touch in compose_batch with a skeleton instruction; at most 60 characters; must not repeat the subject | todo |
| 6 | A PS line in every mail (most-read part after the subject) | No PS block | `ps` named slot after the sign-off; the composer writes one nugget or the single link | todo |
| 7 | Reward the open: the first line pays off on its own (a quote, a usable line) | First line opens on the reader's situation, which is good, but is not standalone value | Skeleton rule: line one must be usable on its own (for example a sample four-line morning story) | todo |
| 8 | Under 200 words, one idea, cut until one thing remains | `maxWords` (140) exists per template but is not enforced on the rendered total; first drafts ran 135 words in the slot plus fixed lines | Validate rendered total at or under 200 words; compose_batch refuses a slot over 90 words | todo |
| 9 | Train clicks: put the nugget in the mail and the rest behind a link, so readers are rewarded for clicking | Assets are inline images; the only clicks are the trial link and the booking link | Hosted "see the screen" page per asset with a tracked link so every mail carries one rewarding click; click-through feeds temperature | todo |
| 10 | Reply-to-get: "reply yes and we send it" (engagement lifts inbox placement) | No reply-triggered delivery | Welcome asks for a one-word reply for a sample; classify intent; the engine sends the asset on the next tick | todo |
| 11 | Optimise click-through over time, not opens (Apple privacy makes opens unreliable); benchmark 35.7% open, 8.5% CTR | Opens flagged unreliable already; no rolling CTR by campaign, mailbox or template | 30-day CTR (clicks per sent and per opened) on the product page; grade templates on clicks and replies | todo |
| 12 | A/B the subject on a small slice, send the winner to the rest | Variant families exist for the welcome only; other rungs have one subject | Two or three subject variants per template, sampled, winner locked after N sends | todo |
| 13 | Deliverability is reputation; sunset dormant people rather than keep mailing them | 200 per day caps and one-click unsubscribe exist; no bounce or complaint rates, no pre-send verification, no sunset rule | Per-mailbox bounce, complaint and reply rates with auto-pause thresholds; MX and syntax check at ingest; silent leads never re-enter | todo |
| 14 | Keep emailing value indefinitely (three sends a week) | The sequence ends at `last_call`; the lead never hears from us again | `nurture` campaign: biweekly value-only mail with no ask; a click or reply re-enters the sequence | todo |
| 15 | Pain-moment hooks from testimonials ("two months from shutting our doors") | Asset library is six screenshots and no customer quotes | Collect three or four "worst moment" quotes as quote assets for the proof rungs (content task) | todo |
| 16 | Contextual CTA and a bridge sentence written for each mail | CTA label is fixed per template | Composable CTA label (URL stays fixed) and a bridge line, both described in the skeleton | todo |

### Top five, in plain terms

1. **Send time.** A lead in Vadodara is stored as UTC today, so mail lands at 02:30 IST and is buried by morning. Infer the timezone and land the mail at 10–12 or 13–15 local, Wednesday preferred.
2. **Preview text.** The inbox row shows subject plus preview. Ours is the template default for everyone. One extra line from Claude per mail makes it specific to the lead.
3. **PS line.** Skimmers read the top and the bottom. Our bottom is the opt-out text. A PS slot gives the composer the second most-read spot.
4. **Word cap.** One idea per mail, under a minute to read. Refuse long drafts at the tool so Claude rewrites rather than a human trimming in Review.
5. **Speed to lead.** Form to webhook to a tested welcome, auto-sent, under five minutes. Keep the human gate for Claude-written steps only.

---

## 2026-09-14 — WsCube Tech, "Email Marketing Automation: Build the Full System (Step-by-Step)"

Source: https://www.youtube.com/watch?v=bGFxAZvfhIU (19 min, Hindi; auto transcript read in full). Presenter Harmeet walks through Apollo.io.

### What the video shows

- Opening analogy: Zomato, Swiggy, Nykaa and Amazon mail you about what you browsed or ordered (dessert lover gets dessert coupons; browsed shoes, get shoe offers). Nobody types those by hand; behaviour data plus AI does.
- Apollo.io setup: business details, target companies, targeting by location, industry and employee count, outreach channel (email, LinkedIn, phone call), which produces a workflow.
- "Create a sequence with AI": subject and body with `{{first_name}}` style variables; an "edit information" brief with pain points, value proposition, call to action, company overview, additional context and social proof, which the AI uses to write better mails. She fills that brief with ChatGPT from the course web page and a screenshot of the form.
- Leads: people list or company list, CSV upload, link the Gmail mailbox, add contacts to the sequence.
- Sequence dashboard: active, paused, finished, bounced, not sent; per-contact preview; a prompt can be set per contact; a warning that image-heavy mails go to spam.
- Step timing: send immediately after the contact is added, or execute after N days; extra steps (phone call) deleted to keep one step.
- Branching: true and false branches on conditions such as mail opened; cold (unread, no response) exits with no action; any reaction sends a Slack or email notification to the owner.

### What the engine already does, and mostly better

- Sequences with per-person AI copy: playbooks, plans and Claude composing each step against the lead card, not one standard prompt for all.
- The brief: product config carries segments with pain and objections, value props, voice and forbidden claims, drafted by Claude from one URL at onboarding.
- Sources: CSV, API pull, webhook push, MCP source; mailbox linking through Google OAuth.
- Statuses per campaign and per action; per-person preview through `preview_template`.
- Step timing: first touch immediate, later steps by `offsetDays` inside cadence bands.
- Open and click gates on steps (`no_open`, `no_click`, `warm`, `cold`).

### What we take from it

| # | Idea | Engine today | Build | Status |
|---|---|---|---|---|
| A | Behaviour-triggered content (the Zomato analogy): the next mail is about what the lead looked at | Site events exist only for `signed_up`; opens and clicks are the only behaviour the plan reads | Record page views on teamgrid.ai (`pricing_viewed`, `feature_viewed:attendance`, `download_viewed`) through the same `/api/e/` endpoint; expose them on the lead card; let a plan step gate on them and let the composer open on the page they read | todo |
| B | True and false branches, not only skips | Gates skip a step when a condition fails; there is no positive branch for "opened but did not click" or "clicked" | Add `opened` and `clicked` gates so a playbook can hold both branches (a clicked lead gets the call, an opened one gets the proof) | todo |
| C | Owner notified on any reaction (Slack or email) | `notify_owner` exists as a tool for Claude; the engine itself does not notify on open, click or reply | Engine-side notification on reply and on first click, in the same tick, to Slack or mail (shared with Hormozi row 2) | todo |
| D | Sequence dashboard strip: active, paused, finished, bounced, not sent | Counts exist across pages but not as one strip per campaign | One funnel strip per campaign: queued, in review, sent, opened, clicked, replied, bounced, finished | todo |
| E | Image-heavy mails go to spam | Same as Hormozi row 4 | Covered by the plain format work | todo |
| F | Bounced and "not sent, wrong address" surfaced per sequence | Bounces come back through the mailbox; no pre-send check | Covered by Hormozi row 13 (MX and syntax check at ingest, bounce rate per mailbox) | todo |
| G | Human steps in a sequence (phone call, LinkedIn) | Channels are email, in-app and WhatsApp | Optional later: a `human_task` step that raises a task for the owner ("call this lead at 11:00") in the UI and Slack | skip for now, no caller on the team |

---

## Merged backlog, by priority

| Priority | Item | From | Status |
|---|---|---|---|
| 1 | Send-time window in the lead's timezone, Wednesday preferred | Hormozi 3 | todo |
| 2 | Preheader per touch | Hormozi 5 | todo |
| 3 | PS slot | Hormozi 6 | todo |
| 4 | Word cap on rendered mail and slot | Hormozi 8 | todo |
| 5 | Speed to lead: webhook source, auto-send tested welcome | Hormozi 1 | todo |
| 6 | Plain format for cold leads, spam-word check | Hormozi 4, WsCube E | todo |
| 7 | Owner notification on reply and first click; React every 15 min | Hormozi 2, WsCube C | todo |
| 8 | Page-view site events and gates on them | WsCube A | todo |
| 9 | Positive gates `opened` and `clicked` | WsCube B | todo |
| 10 | Reply-to-get sample | Hormozi 10 | todo |
| 11 | Rolling CTR reporting; grade templates on clicks and replies | Hormozi 11 | todo |
| 12 | Deliverability guardrails: bounce and complaint rates, pre-send verification, sunset | Hormozi 13, WsCube F | todo |
| 13 | Campaign funnel strip | WsCube D | todo |
| 14 | Subject variants per template | Hormozi 12 | todo |
| 15 | Click-rewarding asset pages | Hormozi 9 | todo |
| 16 | Composable CTA label and bridge | Hormozi 16 | todo |
| 17 | Nurture stream after the sequence | Hormozi 14 | todo |
| 18 | Customer pain-moment quotes as assets | Hormozi 15 | todo |
