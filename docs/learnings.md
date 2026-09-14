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

## 2026-09-14 — Lets Uncover, "Email Marketing Full Course | Beginner to Advance"

Source: https://www.youtube.com/watch?v=byqZe8oaUwA (89 min, Hindi; auto transcript read in the parts that carry strategy). An Omnisend course for WooCommerce and Shopify stores: domain and mailbox setup, store connection, sign-up forms and popups, the welcome and abandoned-cart automations, reports, segments and campaign design.

### What the video shows

- Email returns about 72 dollars per dollar spent against 1–2 percent for ads; 70 percent of businesses never mail the leads they paid for.
- Popups and forms with triggers (after N seconds, exit intent, time on page), targeting (all visitors, not existing contacts, only existing contacts, by segment, by URL, out-of-stock pages, by country, by traffic source such as Facebook), a frequency cap (do not show again for X days), A/B testing of forms, and a success message that carries the discount.
- Welcome automation: trigger "subscribed to marketing" (other triggers: viewed a product, viewed a page, started checkout), a one-minute delay, the discount mail, a one-day delay, a "we miss you" mail, a one-week delay, another mail. **Exit conditions** are goals: placed order, paid order, viewed a page, refund. Once a person meets one they leave the automation and never re-enter it.
- Abandoned cart: trigger "added product to cart", a 1–5 minute delay, mail one with the abandoned products inserted automatically, wait 11 hours, mail two, wait 12 hours, mail three with a discount, then a story or a meme. The reasoning: the person was busy, disliked the price, or is comparing with a competitor, so the later step carries the incentive.
- Other ready automations: order confirmation, shipping confirmation, order follow-up, back in stock, product review request, birthday, wheel of fortune.
- Reports: revenue attributed to automations versus organic, engagement, open rate, click rate, order rate, product performance, per-automation insights, export.
- Campaigns: segments and tags, AI-written subject with an inbox preview, preheader, template library, brand assets (logo, colours) set once and reused, product blocks (best selling, recently viewed).
- Closing advice: do not only sell; alternate informational mails (tips, a blog excerpt with a link to the rest); watch open rate; move the people who opened into a different campaign with a specific offer.

### What the engine already does

- The welcome-plus-delays automation is the plan: first touch immediate, later steps by `offsetDays` inside cadence bands.
- Exit conditions are the goal checks (`signed_up`) plus the booking hand-over: success ends the campaign and skips every queued action.
- Segments, one-click unsubscribe, brand assets and voice set once in product config, AI copy per person.
- Hot-band cadence of 0.1–0.35 days already matches the hours-not-days pacing of an abandoned-cart flow.

### What we take from it

| # | Idea | Engine today | Build | Status |
|---|---|---|---|---|
| H | Abandoned-cart logic applied to our funnel: **abandoned signup** (started the register page, no account after 15 minutes) | The register page reports only `signed_up`; nothing fires on a started-but-unfinished signup | `register_started` site event; a signal-triggered rung that sends within 5 minutes, then 11 hours, then 12 hours; exit on `signed_up` | todo |
| I | Post-purchase lifecycle automations (order follow-up, review request, back in stock) applied to SaaS: **post-signup activation playbook** | `welcome_signup` template exists and activation events are defined in product config (`account_created`, `teammate_invited`, `session_recorded`, `report_viewed`); no playbook walks a signed-up person through them | Activation playbook: install nudge (day 0–1), invite teammates (day 2), first report (day 3), trial ending (day 5–6), win-back after expiry (day 9); each step gated on the activation event not yet seen; exit when activated | todo |
| J | Reactive mails go out in minutes; the sequence mails can take longer | Composed steps wait for the hourly Advance routine; engine-rendered steps go out on the next tick | Design rule: signal-triggered rungs (abandoned signup, install stall, first click) are pre-written templates rendered by the engine; sequence rungs are composed by Claude | todo |
| K | Dynamic blocks from behaviour (the abandoned products appear by themselves) | Merge vars are name, company and trial link | Merge vars fed by site and product events: page last viewed, plan viewed, teammates invited, days since install; usable in templates and shown on the lead card | todo |
| L | Incentive escalates across the flow (10, then 12, then 15 percent) | No offer concept beyond the trial | `offer` asset kind with an expiry (extended trial, done-for-you setup, first month free for teams over ten) pinned to later rungs by the playbook | todo |
| M | Revenue attributed per automation and campaign | Templates are credited on `converted`; no campaign-level view | Signups per campaign, rung and variant on the product page, next to the CTR report from Hormozi row 11 | todo |
| N | Popups with exit intent, source targeting and frequency caps | Site side, not the engine | Hand to the teamgrid.ai site: exit-intent form on pricing offering the four-line sample; a form variant per ad source; never shown to existing contacts | skip in engine, site task |
| O | AI tone switch (funny, serious) per mail | Voice is fixed in product config | Skip: one voice, direct and specific, is the brand | skip |
| P | Inbox preview while writing the subject | No length check on subject plus preheader as the inbox shows them | Fold into Hormozi row 5: validation renders the inbox row and refuses a subject over 60 or a preheader over 90 characters | todo |

---

## 2026-09-14 — Mailtrap, "SaaS Onboarding Emails: 5 Rules Every Team Needs to Know"

Source: https://www.youtube.com/watch?v=Xk3UiFfT1xE (13 min, English; transcript read in full). The most directly applicable of the sources so far: it is about the mails after signup, which is where TeamGrid's value actually starts.

### What the video says

1. **Speed and clarity in the first mail.** Send within 60 seconds of signup (teams that do see 35–40 percent higher activation), from a transactional path or a webhook, not a campaign scheduler; strip heavy templates and tracking scripts that slow delivery. Confirm the stage ("your trial is live"), give one instruction for the next step ("create your first project, it takes two minutes"), and restate the outcome ("track every deadline in one place"). Weak: "explore our blog, check pricing, join our community". Strong: one message, one action, one immediate payoff.
2. **Time by behaviour, not by calendar.** Day-one, day-three, day-five sequences land out of step with the user. Trigger on in-app events instead: first login sends the quick start, first project suggests the next feature, no activity for three days sends a nudge, a milestone gets a celebration plus the next step. Appcues lifted activation 2.5 times this way. Track activation per trigger.
3. **One action per mail.** A single call to action gets 371 percent more clicks (Campaign Monitor). Each mail is one activation milestone: "start by inviting your team; collaboration unlocks your first project".
4. **Success loops after setup.** Products that go silent after setup lose up to 30 percent of users before the first renewal. Keep showing progress in their numbers: "you automated three tasks this week and saved two hours; next, connect an integration".
5. **One activation map across teams.** Marketing sets tone, product triggers on behaviour, customer success steps in at friction; each touchpoint has an owner; weekly review.

Framework: find the activation moment and the drop-off points from data (the cohort that upgraded within 14 days and the actions they took first); build a guided flow where each milestone has its own trigger, mail and goal; let the app drive the click and the mail explain why (no duplicate tooltips); make the flow adaptive (fast movers skip steps, stalled users get nudges, admins and execs get different mails); measure activation rate, trial-to-paid and 30/60-day retention, not opens.

### What the engine already does

- Activation is defined in product config (`account_created`, `teammate_invited`, `session_recorded`, `report_viewed`) and `welcome_signup` exists for signups.
- The register page already reports `signed_up` through `/api/e/`, so a webhook-shaped path into the engine exists.
- Templates carry one CTA block by design; the voice says one idea and one link.

### What we take from it

| # | Idea | Engine today | Build | Status |
|---|---|---|---|---|
| Q | First mail within 60 seconds of signup | `signed_up` is recorded and verified on the spot, but the signup welcome waits for the next tick and, under `gate_on`, for a human | Send `welcome_signup` inside the `signed_up` request path (tested template, engine-rendered, no approval gate); measure time-to-first-mail | todo |
| R | First mail confirms the stage, gives one instruction, restates the outcome | `welcome_signup` content not yet checked against this shape | Rewrite `welcome_signup`: "your workspace is live", one step ("install the agent on one machine, five minutes"), one outcome ("tomorrow morning you get yesterday in four lines") | todo |
| S | Behaviour-timed activation steps | Playbook steps are day offsets with open/click gates | Gates on product events: `event_seen:<name>` and `no_event:<name>` plus `idle_days:N`; fast movers skip completed steps, stalled users get the nudge; feeds the activation playbook (Lets Uncover I) | todo |
| T | One ask per mail | `book_call` carries two asks (reply "call" and the trial button); other rungs one | Template audit: one CTA per mail; the second route moves to the PS line or goes | todo |
| U | Success loops in their numbers after setup | No product data in mails | Weekly progress rung after activation with real numbers from the workspace (teammates tracked, hours captured, blockers surfaced) through a product MCP connection; the same vars serve Lets Uncover K | todo |
| V | Measure activation, trial-to-paid, retention per trigger | Only send-level metrics | Per-campaign and per-rung activation rate, trial-to-paid and 30/60-day retention from product events, next to conversion attribution (Lets Uncover M) | todo |
| W | Mail explains why, app shows how | No rule | Voice rule for activation templates: no click-by-click steps; say what the step unlocks; link into the app screen that does it | todo |
| X | Find the aha moment from data | No activation analytics | Once product events flow: report the common first actions of users who converted within 14 days; order the playbook by it | todo, needs data |
| Y | Activation map with owners | None | `docs/activation-map.md`: milestone, trigger, mail, owner, metric; reviewed weekly | todo |

---

## 2026-09-14 — Instantly, "Alex Hormozi's Lead Generation Strategy for 2026"

Source: https://www.youtube.com/watch?v=oZ18-kMrmKw (22 min, English; transcript read in full). A summary of Hormozi's lead-generation philosophy with an Instantly product walkthrough. Mostly top of funnel, which is upstream of the engine (our leads arrive from ads), so most of it is context rather than a build.

### What the video says

- Five philosophies: build a self-reinforcing system (customers give reviews and referrals that bring customers); reciprocity (give away what others charge for, so people feel they owe you); extreme ownership; avoid linear growth (systems, automation and content that work while you sleep); three pillars: quality leads, treat customers well, get reviews and referrals.
- Warm outreach first: call the people you already know with a script (ask about their life, ask if they have time for the thing you solve, ask who else, offer it free or discounted for a review and a referral); track it in a CRM; a tool can automate it.
- The offer formula from "$100M Offers": dream outcome times perceived likelihood, divided by time delay times effort and sacrifice. Every offer statement should cover all four.
- Cold outreach solves three problems: who to contact (scrape, buy or build a list), what to say (a personalised line, then big fast value: offer, proof, guarantee, and something valuable given free, such as a personalised video), and not enough chances (volume plus automation plus analysis; most people grossly underestimate the volume needed).
- Content is the lubricant for ads and outreach: short-form top of funnel, long-form educational, pre-selling content that answers objections before the call; show proof everywhere; consistency over years.

### What the engine already does

- Personalised opening line per lead from the site text, written by Claude rather than a template prompt.
- An objection rung (`privacy_objection`) and a proof rung exist in the ladder.
- Mailbox pool with daily caps; replies ingested and attributed.

### What we take from it

| # | Idea | Engine today | Build | Status |
|---|---|---|---|---|
| Z1 | Big fast value first: give something they would pay for before any ask | Welcome B's subject is "what tomorrow's summary would say" but the body describes it rather than delivering it | Generated give-first asset: Claude writes a plausible four-line morning summary for a team like theirs from the site text, rendered as a card in the welcome; the same asset answers Hormozi rows 7 and 10 | todo |
| Z2 | Offer formula: outcome, likelihood, time, effort in every ask | `book_call` fixed text already states it (15 minutes, installed on the call, you keep the workspace); other CTAs do not | Add to the product voice: an ask names the outcome, why it is likely for them, how long it takes, and what they do not have to do; skeleton note repeats it | todo |
| Z3 | Reviews and referrals loop | Nothing asks a happy user for a quote or a referral | Post-activation rungs at day 14 and 30: ask for one line of feedback (becomes a quote asset, Hormozi row 15) and a referral to one team they know | todo |
| Z4 | Pre-selling content that answers objections | The objection rung answers in the mail only | Objection rungs link to a page on teamgrid.ai that answers it in full (privacy, "is this monitoring", pricing); the page is also the click-rewarding link from Hormozi row 9 | site task plus a template edit |
| Z5 | Volume, list building, warm outreach scripts, Instantly features | Leads come from ads; caps are a decision | Skip in the engine; the ad budget is the volume lever | skip |

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
| 19 | Post-signup activation playbook (install, invite, report, trial ending, win-back) | Lets Uncover I | todo |
| 20 | Abandoned-signup trigger with a five-minute template mail | Lets Uncover H | todo |
| 21 | Signal-triggered rungs are engine-rendered templates; sequence rungs are composed | Lets Uncover J | todo |
| 22 | Behaviour and product merge vars (page viewed, plan viewed, teammates invited) | Lets Uncover K | todo |
| 23 | Conversion attribution per campaign, rung and variant | Lets Uncover M | todo |
| 24 | Offer asset kind with expiry for later rungs | Lets Uncover L | todo |
| 25 | Site: exit-intent and source-targeted forms with frequency caps | Lets Uncover N | site task |
| 26 | Signup welcome sent inside the `signed_up` request, under 60 seconds | Mailtrap Q | todo |
| 27 | Rewrite `welcome_signup`: stage, one step, one outcome | Mailtrap R | todo |
| 28 | Product-event gates (`event_seen`, `no_event`, `idle_days`) for activation steps | Mailtrap S | todo |
| 29 | One ask per mail; fix `book_call` | Mailtrap T | todo |
| 30 | Weekly progress rung with the workspace's real numbers | Mailtrap U | todo |
| 31 | Activation, trial-to-paid and retention per campaign and rung | Mailtrap V | todo |
| 32 | Give-first asset: generated four-line sample summary in the welcome | Instantly Z1 | todo |
| 33 | Offer formula in the voice and skeleton note | Instantly Z2 | todo |
| 34 | Review and referral rungs after activation | Instantly Z3 | todo |
| 35 | Objection pages on the site linked from objection rungs | Instantly Z4 | site task |
| 36 | Activation map document with owners | Mailtrap Y | todo |
