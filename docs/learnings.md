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

## 2026-09-14 — Roshan, playlist "SaaS Email Marketing Growth" (7 videos)

Source: https://www.youtube.com/playlist?list=PLGC1vB3Ueju6C1UneCGulSr61EG5skwTq (about 67 min in total, English; all seven transcripts read in full). An agency owner's lifecycle-email system for SaaS: the three-step playbook, the twelve to fifteen flows, the onboarding flow, the five churn flows, a process for custom flows, the five core flows to build first, and the campaign layer.

### What the playlist says

- **Three steps.** Map the whole customer journey first (awareness, lead magnet, trial signup, trial to paid, onboarding, retention, upsell, churn signals, cancellation, win-back; hundreds of actions, a dozen milestones). Then a flow for every point of it, each triggered by a behaviour, with logic splits and copy written for that behaviour, so that behaviour, flow, next behaviour, next flow runs as a cycle with no gaps. Then broadcast campaigns to segments. Copy-pasted templates fail because the journey differs per product.
- **The flows.** Welcome (trial to aha moment to paid), post-trial, abandoned payment (a price objection), payment decline (a logistics problem), onboarding per plan, achievement or gamification (milestones, congratulations, the road map to the next one, something exclusive), upsell to annual, feature-limit upsell, review request (G2, Capterra), referral with an incentive for both sides, no-login churn prevention (5–14 days), low-activity churn prevention (logging in but not doing the actions that produce results), viewed the cancellation page four times this week, cancellation (prevent, then a survey), win-back (60–90 days, or the product's natural usage cycle), sunset the unengaged.
- **Welcome flow shape.** Find the aha moment from the last few hundred trials that converted (the actions they had in common). Break the path into two to four actions. One short sequence per action; the moment the action happens the person jumps to the next sequence and never sees the rest. Only after the last action comes the upgrade sequence: proof, urgency, direct-response copy.
- **Onboarding flow shape (after purchase).** Activate with about three core actions to a first quick win; only then introduce the full feature set; future-pace results at one, two, three and six months (direct benefit, then money, then their day); add social proof and the community. Measure activation, breadth of feature use, positive replies, time to results.
- **Reactivation copy.** Remind them of the results they were getting, then amplify the problem across the flow until "you are back to the problems you had before".
- **Custom flows process.** Find a gap in the journey from the metrics (tier-3 activation lower than tier 2), name the revenue variable it moves (customers, retention, revenue per user), define the exact output, decide the structure (prerequisite features A and B before pushing X), set the trigger and delays (unused after month one; wait two to three days and offer help; wait a week; then push), build, measure, iterate.
- **Campaign layer.** Mutually exclusive segments: leads and prospects (never paid), paying customers per plan with their own ICP, churned; plus a 30-day engaged segment. One to two campaigns per segment per week, about sixteen a month in total, each with one goal. Content buckets: new value content, customer success stories, product deep dives, conversion asks, product updates; measure conversion per bucket and double down. Non-buyers get value teased in parts, each part linked to the product, then a direct ask for the trial (with an extension or incentive for low intent). Buyers get problems solved at their scale, never generic business advice.
- **Measurement.** UTM parameters on every CTA so revenue per email shows in analytics; only three end metrics (conversions, churn, revenue per user); map every flow to the variable it moves and judge it by that; split-test preview text, subject, CTA, offer and flow length continuously (90 percent significance within 48–62 hours).
- **Design.** In SaaS the copy carries the mail; an image exists only to make a point in the copy land better. Clean, on brand, never decorative.

### What the engine already does

- Behaviour-triggered flows with logic splits are what goals, playbooks and gates are. The welcome-family ladder for ad leads is the "welcome flow" of this model, up to the aha moment of signup.
- Segments per belief and temperature, Thompson-sampled variants, the review queue, click and reply attribution, template credit on conversion.
- `person.stage` exists, currently only "lead".

### What we take from it

The engine covers one step of the journey, ad lead to signup. This playlist says the money is in the rest. Almost every flow below needs one thing first: a product event stream from teamgrid.ai (login, session recorded, teammate invited, report viewed, checkout started, payment failed, plan limit reached, cancelled) into the existing `/api/e/` endpoint or an MCP source.

| # | Idea | Engine today | Build | Status |
|---|---|---|---|---|
| P0 | Product event pipe | Only `signed_up` arrives from the site | Site events for login, session, invite, report, checkout, payment, limits, cancel; stored on the person and the lead card; gates and triggers read them | todo, prerequisite |
| P1 | Lifecycle stages as first-class state | `stage` is always "lead" | `stage`: lead, trial, activated, paying (per plan), churned, won_back; moved by events; every goal declares the stage it serves; a person is in one stage-campaign at a time | todo |
| P2 | Trial-to-paid flow after the aha moment | Nothing after signup | Upgrade sequence only after activation: proof, the plan for their size, urgency near trial end; abandoned-checkout branch on `checkout_started` without payment | todo |
| P3 | Post-trial flow | Nothing | Trial ended without paying: reactivate with what they saw, offer an extension once | todo |
| P4 | No-login and low-activity churn flows | Nothing | No login 7 and 14 days; logged in but no report viewed for 10 days; copy: results they had, then the problem amplified | todo |
| P5 | Achievement flow | Nothing | Milestones from product data (first report, first week captured, 5 and 25 teammates tracked, 1,000 hours): congratulate, road map to the next, something exclusive | todo |
| P6 | Feature-limit and annual upsell | Nothing | `plan_limit_reached` triggers the upsell with a quantified benefit; annual offer at day 60 of paying | todo |
| P7 | Cancellation, survey, win-back | Nothing | On cancel: address the reason, one incentive, then a two-question survey; win-back at 60 and 90 days; survey reasons fed back into the objection rungs | todo |
| P8 | Payment decline flow | Nothing | Three mails over ten days on `payment_failed`, ending with the data-loss notice | todo, needs billing events |
| P9 | Broadcast campaigns to segments with content buckets | Goals are per person; no broadcast object | `broadcast` kind: segment, bucket, one goal, sent under the same caps and review; conversion per bucket in reports; mutually exclusive stage segments plus a 30-day engaged filter | todo |
| P10 | UTM on every CTA | Tracked redirect only | `utm_source=email&utm_campaign=<goal>&utm_content=<templateKey>` appended to every CTA URL so teamgrid.ai analytics attribute signups to mails | todo, small |
| P11 | Every goal names the revenue variable it moves | Not recorded | `moves: customers | retention | arpu` on goals and playbooks; reports group by it | todo |
| P12 | Continuous split tests beyond the subject | Variants only for the welcome family | Variant support on preheader, CTA label and offer blocks, same sampling and grading | todo, extends Hormozi 12 |
| P13 | Onboarding order: quick win first, features after, future-pace results | Not encoded | Activation playbook order and a voice rule for activation templates ("what week one, month one and month three look like") | todo, folds into Lets Uncover I |
| P14 | Custom-flow design checklist | Not written | Add to `docs/orchestration.md`: gap, variable, output, structure, trigger and delays, build, measure | todo, doc |
| P15 | Journey map with hundreds of actions | Not written | Extend the activation map (Mailtrap Y) to the full journey: milestone, event, flow, owner, metric | todo, doc |

---

## 2026-09-15 — AMZ One Step newsletter, 13 marketing emails

Source: `testting.zip`, thirteen emails forwarded by a teammate, sent 17 July to 17 August 2026 by an Amazon-listing agency to a subscriber list through AWeber. All thirteen read in full.

Context: this is a warm nurture list (the subscriber also receives the agency's weekly support-call invitations), not cold outreach. The structure of the mails transfers to our follow-ups and to a nurture stream; the casual register and the hype do not, because TeamGrid mail follows the professional tone and the no-names rule.

### What the emails do

- **Cadence and mix.** Thirteen mails in 31 days, one every two to three days. Six promote or remind about a live session, three teach something and then invite to a session, four teach something and ask for a reply or a booked call. The July mails lean on hype and events; the August mails lead with teaching and are clearly the stronger set.
- **Subjects.** Each subject is a specific claim, a number or a question about the reader's own metric (a conversion rate on a named price point, a three-answer audit, a "math most sellers never run"). None says "welcome", "update" or the product name.
- **First line pays off.** The opening states the number, the deadline or the contrarian claim immediately; there is no introduction of the sender.
- **One teachable idea per mail.** A two-minute funnel calculation (impressions, clicks, orders, before and after a one-point change), a three-part image framework, three diagnostic buckets, a "nobody owns this job" argument. The reader can use it without ever replying.
- **Worked numbers.** Before-and-after arithmetic the reader can check on a napkin, rather than adjectives.
- **Self-diagnosis.** The reader is asked which of three buckets they are in, which makes the reply ask feel like the natural next step.
- **Low-commitment reply asks.** "Reply with your listing URL" or "reply with how many products you have"; replies are cheap for the reader and lift inbox placement.
- **Enemy framing.** A named mistake (bulk AI rewrites, chasing new channels, scaling ad spend on an untested page) that the reader can avoid.
- **Timely hooks.** A platform change with a deadline, a live session starting in an hour or fifteen minutes.
- **Format.** Plain-text look, one- or two-line paragraphs, one image at most, one destination (the same link repeated up to three times), a postal address and an unsubscribe link in the footer.

### What not to copy

- Unverifiable claims and inflated multiples, repeated capitals ("BRAND NEW" six times in one mail), emoji bullets, and capacity scarcity that is not real. They conflict with the professional tone and trip spam filters.
- The first name in the subject (our subject rule forbids it, and the UK list has no names).
- A named individual as sender, with the name changing between mails. Our sender stays "The TeamGrid Team".
- Contractions, fragments and slang ("wanna", lowercase "i").
- Six event mails in a month: we have no live session, and a cold list tolerates far less frequency than a subscriber list.

### How our mails compare today

- The welcome subject is "Welcome to TeamGrid", sent to people who never signed up, and the body describes features rather than a problem the reader has.
- The seven `feature_followup` mails are each about a feature. The stronger emails in this set are each about the reader's metric, and the product is named once, near the end.
- Every mail is a branded HTML card with a large trial button. The ask is always the highest-commitment one (start a trial); the only reply ask is the P.S. about a setup call.
- There are no worked numbers, no diagnostic question and no timely hook.
- The footer has no postal address.

### Gaps and what to build

| # | Tactic from the emails | Engine today | Build | Status |
|---|---|---|---|---|
| AOS1 | Insight emails instead of feature emails | `feature_followup` family: seven mails, one feature each | New family `insight_followup` with five to seven mails, each one problem, one worked number, one framework, one diagnostic question, one soft ask; the lead planner may mix both families | todo |
| AOS2 | Subject is a claim, number or question about the reader's metric | Welcome subject "Welcome to TeamGrid"; feature subjects name the feature | Subject rule in the skeleton and voice: a specific number, a named mistake, or a question; never "welcome" to a lead who has not signed up; subject variants to test (extends Hormozi 12) | todo |
| AOS3 | Worked arithmetic the reader can check | No numbers in follow-ups; the UK intro quotes benchmarks only | Per-segment "hour math" block: team size, hours, unrecorded share, charge-out rate, annual cost; labelled illustrative; composer fills team size when known | todo |
| AOS4 | Three-bucket self-diagnosis with "reply with the number" | No diagnostic question | Diagnostic slot in insight mails; classify the reply (bucket 1, 2 or 3) and let React pick the next mail for that bucket | todo |
| AOS5 | Reply ask before trial ask | Every mail asks for the trial | Ask ladder: first two follow-ups ask for a reply (team size, bucket), trial button from the third, or at once after a click; strengthens backlog 10 | todo |
| AOS6 | Timely hooks per segment | None | Dated hook assets per segment, for example UK practices and the 31 January self-assessment peak, with an expiry so they stop after the date | todo |
| AOS7 | Named mistake framing | Forbidden-claims list only | Voice note: each insight mail may name one common mistake the reader can avoid; never disparage a named competitor | todo, voice |
| AOS8 | Postal address in the footer | Footer has the brand name and unsubscribe only | Brand setting `postalAddress` printed in every footer (UK PECR and CAN-SPAM expect sender identity and a contact address) | todo, small |
| AOS9 | Hype guard | No spam or hype check | Validation rejects repeated capitals, emoji bullets, multiples without a source, and scarcity phrases; extends backlog 6 | todo |
| AOS10 | Nurture newsletter after the sequence | Sequence ends at the final email | Weekly insight mail with no trial ask, drawn from the insight family; a click or reply moves the lead back to the plan; same as backlog 17 | todo |

---

## 2026-09-15 — Reddit research: pain points, use cases and competition

Source: Reddit threads from 2024 to 2026, read through the Arctic Shift archive because reddit.com blocks our search and fetch tools. Twenty subreddit and keyword pulls (about 430 posts) across r/managers, r/remotework, r/antiwork, r/sysadmin, r/humanresources, r/agency, r/msp, r/Accounting, r/smallbusiness, r/Entrepreneur and r/developersIndia, plus the top comments on seventeen high-signal threads. Cross-checked against teamgrid.ai (features, pricing, accounting and remote-team solution pages, the Hubstaff comparison), competitor pricing, and the ACM paper "It's Always a Losing Game", which studied worker posts in nine subreddits.

Context: the buyer (owner, manager, HR, practice partner) and the person being measured both post about this category, and they want opposite things. Content has to solve the buyer's problem while answering the team's objection in the same mail.

### What buyers complain about

- **Paying for hours they cannot verify.** Agency owners who pay for more hours than were worked and have no way to show it; leadership that sees billable hours that feel inflated; a CPA with one remote employee who wants metrics.
- **Timesheets are reconstructed, not recorded.** Tracking as you go is easy; rebuilding the week on Friday is the painful part. Accountants who reach the weekly billable minimum move further hours to next week's sheet; staff unsure what to log while waiting on a review; a small-firm COO phoning staff on Friday night about timesheets.
- **An unprofitable client hides in the hours.** An MSP owner found one engineer spending half his day on a client paying a small monthly fee. An agency's first utilisation report showed some people under 10% utilised.
- **Managers inherit a tool with no metrics.** Leadership installs monitoring, will not share what is measured, and asks managers to "improve" the numbers; meetings and calls count as idle. An HR generalist became the owner of a monitoring rollout (tool choice, policy, manager training) with no extra pay.
- **Seat minimums and bloat.** Most monitoring tools sell a five-seat minimum to a practice with one remote hire; agency owners ask why remote time tracking is still bloated and expensive.

### What the measured team complains about (the objection every mail must answer)

- **Activity is not output.** A keystroke leaderboard ranks the fastest typist first and the best strategist last. A new engineer was questioned for being "away" 40 minutes while watching a training video. Goodhart's law is the most repeated comment.
- **Monitoring suppresses useful work.** After keystroke monitoring arrived, nobody reported a three-hour outage for fear of looking off-task (3.5k upvotes).
- **Gaming.** Mouse jigglers, typing gibberish, scripted clicks; surveys put jiggler use at about one in six remote workers.
- **Silent or hidden installs.** Software pushed by IT with no announcement; a tracker installed on a personal laptop and hidden from view; managers reading private chats.
- **Good people leave.** Commenters call it software that generates resumes; managers report Glassdoor damage and hiring trouble after an obsessive rollout.
- **Breaks become evidence.** Water, bathroom and thinking time show up as idle.

### What both sides agree on

- Measure output, not presence. The most upvoted manager advice is a weekly review of what was produced.
- Transparency: employees see their own data, know what is recorded, and have a say in the metrics.
- Longer evaluation periods (weekly or monthly, not minute by minute).
- In HR circles the stated shift is from catching people out to finding where work gets stuck.
- An HR post asking for "privacy-respecting monitoring" was called an oxymoron. The phrase alone is not believed; it needs proof.

### Where TeamGrid stands

| Tier | Examples | Price per user per month | What Reddit says |
|---|---|---|---|
| Surveillance | Teramind, Time Doctor Premium, Hubstaff with screenshots, Monitask, TeamLogger, Insightful | Hubstaff $4.99 to $25, Time Doctor $6.67 to $20, ActivTrak $7 to $25 | The category Reddit hates: screenshots, keystrokes, idle timers, hidden installs |
| Manual timers | Toggl, Clockify, Harvest | Free to low | "We suck at time tracking": a behaviour problem, not a tool problem |
| India analytics | We360.ai, ProHance | We360 from ₹299; ProHance on quote | Support and analytics depth complaints; same entry price as TeamGrid Standard |
| TeamGrid | Automatic capture, no screenshots or keystrokes, AI summaries, Ask TeamGrid, auto timesheets, billable capture | Standard ₹299, Advanced ₹649, 7-day trial, no card | Matches what both sides ask for, if it is proven |

Strengths the research supports: no screenshots or keystrokes, employees see their own data, work summaries instead of activity logs, automatic timesheets (no reconstruction), billable capture and client margin for firms, entry price below Hubstaff's starter.

Risks: "Productivity Scoring" and "App & Website Tracking" read like the keystroke leaderboard Reddit mocks unless we say what the score is built from; "Email Insights" sounds like reading email; "privacy-first monitoring" is disbelieved as a phrase; comparison pages exist for six tools but not for manual timers (Toggl, Clockify, Harvest) or the screenshot tools Reddit names most (Monitask, TeamLogger, Teramind). To verify with the product team: whether meetings and training videos are classified as meeting time rather than idle, and whether there is a seat minimum.

### Gaps and what to build

| # | Finding | Engine or content today | Build | Status |
|---|---|---|---|---|
| RD1 | Pain stories are the strongest hooks (the leaderboard, the unreported outage, the training video logged as idle, the client eating half a week, the Friday timesheet) | Feature mails, no stories | Hook library asset: eight to ten story hooks, paraphrased, each with the pain, the illustrative number and the TeamGrid answer; the insight family draws from it | todo |
| RD2 | Every buyer fears the team's reaction | Trust line only | "What TeamGrid never records" block in insight mails and a forwardable one-page explainer written for employees | todo |
| RD3 | Buyers sit in three situations | No diagnostic | Three buckets for the diagnostic question: timesheets from memory, a timer tool nobody fills in, a screenshot tool the team resents; merge with AOS4 | todo |
| RD4 | Managers are handed a rollout with no metrics or policy | Nothing after signup | Rollout kit: announcement mail to staff, short policy text, FAQ; used in the post-signup activation playbook (backlog 19) | todo |
| RD5 | Segment-specific pains | UK accounting intro only | Segment hooks: accounting (minimum-hours shifting, review time squeezed before filing), MSP and IT services (one client eating an engineer's week), agencies (first utilisation report), offshore teams (consent and no hidden install) | todo |
| RD6 | Category words trigger the objection | Copy uses "monitoring" and "productivity score" | Voice note for cold copy: lead with "billable hours captured", "where the week went", "work summaries"; avoid "monitoring", "tracking employees" and "productivity score" in subjects | todo, voice |
| RD7 | Competitor gaps in content | Six comparison pages | Comparison or alternatives pages for Toggl, Clockify, Harvest, Monitask and Teramind; one for "time tracking without screenshots" | site task |
| RD8 | Meetings logged as idle and seat minimums are sharp, specific complaints | Unverified for TeamGrid | Confirm with the product team; if true, use "meetings are not idle time" and "no five-seat minimum" as proof lines | todo, verify |

---

## 2026-09-15 — Brainstorm: relatable copy, the asset store and a self-learning loop

Source: discussion with Dhaval after the Reddit research, checked against the code and the live TeamGrid send record (`what_works`), plus outside evidence on plain text versus HTML and price framing.

Context: the mails restate teamgrid.ai and read as generic. The ask is copy a reader recognises from their own day (for example a monthly seat priced against something they already buy), chosen and improved by the Claude routines within a written rulebook, with a person approving.

### What the code and data show today

- **Asset store is built and stocked, but never used.** The schema carries kind, tier, `useWhen`, `proves`, segment, expiry, approval and usage counters (`src/schemas/asset.ts`); `lead_card` offers `assets_available`, `plan_goal` takes `asset_id`, `compose_batch` takes `asset_ids`, and `what_works` cuts results by asset. TeamGrid had seven active assets (six screenshots and the setup-call booking), and `lead_card` offers four of them to a cold lead, yet none of 289 TeamGrid actions carries an asset. The compose prompt (`docs/routine-prompts.md` 2.1) never mentions assets, and the `lead_card` tool description tells the composer that most touches are words alone. (An earlier note here said the store was empty; that check read the wrong database.)
- **Some screenshots undercut the pitch.** `shot_today_story` and `shot_needs_attention` name individuals and describe a security vulnerability and credential failures. Several app blocks in `assets/teamgrid/app/blocks` rank named people (AI adoption, team goals), and the team goals block shows real team members' names. They contradict "patterns, not people", which is the objection the Reddit research says matters most. Aggregate blocks such as projects by share are safe.
- **Per-lead material exists.** Of 65 TeamGrid leads, 63 have team size and timeline from the form, 41 wrote a main problem in their own words, and 31 have their site text. Classification can misfire: a Pune property mandate firm's team lead is filed as `eng_leader`, so segment-filtered assets would offer engineering stories.
- **Format is a template setting, not a Claude decision.** `format: html | text` defaults to `html` (`src/schemas/template.ts:103`); a per-action override is read at send (`src/engine/fireDue.ts:349`) but nothing sets it, and results are not cut by format.
- **Learning exists for the welcome only.** Thompson sampling over welcome variants (`src/engine/templates.ts:404`); angles are recorded and reported, but nothing shifts volume between angles, assets or formats automatically.
- **Rules exist in part.** `voice.do`, `voice.dont`, `forbiddenClaims` and repeated-claim checks (`src/engine/validate.ts:61`). There is no check that a number has a source.
- **Volume is small.** 96 sends, 0 replies, welcome click rate about 6%. A learning loop needs research-based starting defaults because the data alone will take weeks to decide anything.

### Outside evidence

- Plain text drew 7.9% total response against 4.2% for HTML across 250,000 B2B cold emails (The Growth List, reported by Warmy and Warmforge); Puzzle Inbox reports 15 to 25% more replies for plain text.
- Temporal reframing: an ongoing 85 cents a day was accepted by 52% against 30% for $300 a year (Gourville, "Pennies-a-Day").
- Josh Braun's "poke the bear": state the cost of doing nothing and ask a neutral question instead of pitching.
- Price anchors, checked 2026-09-15: a Domino's India medium pizza costs ₹199 to ₹449; the average UK coffee costs £3.97 (Finder).

### Relatable framing, worked

| Reader | Generic line | Relatable line |
|---|---|---|
| Indian founder | Standard plan at ₹299 per user per month | ₹299 is one medium pizza, or about ₹14 a working day for a month of one person's work summaries |
| UK practice partner | About £2.30 per user per month | At a £60 charge-out rate, a month of TeamGrid costs less than three billable minutes |
| UK practice partner | Capture billable time automatically | Twenty unlogged minutes a day across ten staff is about 730 hours a year |
| Agency owner | AI work summaries | The first utilisation report usually surprises the owner, not the team |

### The loop

1. **Maintain (daily):** refresh research, draft new assets (stories, sourced stats, price anchors with an expiry) with `origin: claude` and `requiresApproval: true`; a person approves each once.
2. **Acquire (hourly):** the planner reads `what_works` and the lead card, and picks angle, asset and format for each step with a reason.
3. **Advance (hourly):** the composer writes subject, opening and slot around the chosen asset; the engine validates against the rulebook.
4. **React and Close:** clicks, replies and signups are credited to the angle, asset and format used.
5. **Bandit:** Thompson sampling over angle, asset and format with a fixed exploration share; an arm with enough trackable sends and no signal is retired, and Claude drafts a replacement.

### Rulebook (hard rules enforced by the engine, soft rules in the prompt)

- Hard: every number carries a source asset or the word "illustrative"; no named competitor disparaged; no person as sender, no lead company name, never "you clicked our ad"; no contractions; no "monitoring", "tracking employees" or "productivity score" in a subject; no repeated capitals, emoji bullets or scarcity; slot at most 90 words; the same asset never twice to one lead.
- Soft: the price anchor must match the reader's country and currency and the register of their role (billable minutes for a practice partner, not food); one idea per mail; open on the reader's situation.

### Gaps and what to build

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| RL1 | Too few assets for relatable copy: seven, all screenshots or booking | Six screenshots and one booking asset | Seeded 20 drafts on 2026-09-15 (`origin: claude`, `status: draft`): sourced stats, an illustrative calculation, price anchors framed per country and role, product facts that answer objections, six paraphrased Reddit stories (approval required), five page links. A person reviews and activates them on the brand page | doing, review |
| RL7 | The composer never attaches an asset | Prompt silent; `lead_card` description discourages | Compose prompt: for each step, pick the asset that answers this lead's stated problem or likely objection, or say in one line why words alone are better; `what_works` then shows the difference | todo |
| RL8 | Copy is generic because it is written from the product outward | Opening line from site text only | Per-lead brief before writing: their world (site text, city, industry), their words (form main problem), team size, likely objection; the analogy comes from their world, the numbers only from an attached asset; one honest limit when the fit is partial (for example field staff away from computers) | todo |
| RL9 | Screenshots that name people or show incidents | Two active assets affected | Pause `shot_today_story` and `shot_needs_attention`; replace with aggregate blocks (projects by share) re-captured from an anonymised workspace | todo, needs approval |
| RL2 | Stories and price anchors have no asset kind | Kinds: image, video, document, link, quote, stat, access | Add `story` and `analogy` kinds, with source and checked date; price anchors require `expiresAt` | todo |
| RL3 | Format is fixed per template | Template field, unused override | `format` per touch in `compose_batch` and `plan_goal`; stored on the action; `what_works` cut by format; cold default `text`, HTML after a click or signup | todo |
| RL4 | Learning covers the welcome only | Thompson on welcome variants | Bandit over angle, asset and format for planned steps; exploration share; retirement rule; weekly summary to the owner | todo |
| RL5 | Unsourced numbers pass validation | Forbidden-claims check only | Validator: a number in copy must come from an attached asset or be labelled illustrative | todo |
| RL6 | New creative never enters the system on its own | Assets added by hand | Maintain drafts assets from research into an approval queue on the brand page | todo |

---

## 2026-09-16 — Brainstorm: LinkedIn, the official API, and the channels we are missing

Prompted by a plain question: can we add LinkedIn and other channels, and which important one are we missing? The
answer turned into a survey of what LinkedIn actually permits, what it charges, and what the cheapest honest way to
test the channel is before any of it reaches the engine. Nothing here is built yet; this section exists so the
research does not have to be repeated.

### What the engine has today

| Channel | Reaches | State in the repo |
|---|---|---|
| Email (Gmail OAuth, SES, SMTP, HTTP, MCP) | Anyone, near-free | Live. DNS still blocking the new sending identity |
| WhatsApp (HTTP, MCP) | Phone, opt-in or 24-hour window | Adapter live, no business number connected |
| Voice (Bolna) | Phone, cold-callable in India | Live, first test call worked |
| SMS | Phone | Catalogue entry marked `soon`, waiting on sender registration |
| LinkedIn | B2B decision maker | `channelKey` enum only. No catalogue row, no adapter |
| In-app | Existing user | Enum only |
| Push | App installs | Enum only |
| Retargeting audience | The whole lead list at once | Not modelled anywhere |

`channelKey` in `src/schemas/common.ts` already lists `linkedin`, `in_app` and `push`. The enum promises three
channels the code cannot send on.

### The channel we are missing, and why it matters now

LinkedIn. For the UK accounting list and for B2B buyers generally it is where the partner actually reads, and it is
the natural answer while email is blocked on DNS: voice is high friction for a cold UK practice, and WhatsApp is the
wrong register for one entirely.

The second, less obvious miss is a retargeting audience sync — pushing hashed lead emails to LinkedIn or Meta matched
audiences so the practice sees the brand while the email lands. It never got modelled because it is a channel with no
`send()`: there is no per-message action, only an audience that is kept in step. It costs ad budget, which is why it
stays a separate decision.

### Why the official LinkedIn API cannot run our ladder

There is an official API. It cannot do what we want, and no amount of partner status changes that.

- **No invitation endpoint exists.** LinkedIn removed open public API access in 2015 and never published a
  connection-request endpoint. There is no official way to become someone's first-degree connection.
- **The Messages API is real but doubly blocked.** `POST /v2/messages` is documented, but usage is restricted to
  approved partners, and the requirements forbid automation outright: a message must be tied to a specific member
  action, and the docs state that member actions do not include an automated or scheduled event. The member must be
  shown an editable draft of the subject and body and must click send themselves. It also only reaches first-degree
  connections. That API exists for CRM and compliance archiving, not for a sequencer.
- **Pages Messaging is inbound-only.** A Page can reply to a member who messaged first; it cannot initiate. Access is
  limited to six launch partners.
- **Sales Navigator (SNAP) stopped accepting new partner applications** in 2026.
- **Marketing Developer Platform access is real but slow.** Development tier first, Standard after a video review;
  reported approval timelines run four to eight weeks at best, three to four months typically.

### The official route that does reach a cold inbox

Message Ads and Conversation Ads (Sponsored Messaging). These land in the real LinkedIn inbox, are fully within the
terms, need no connection, and carry no account risk.

- Billed cost-per-send, not per open — paid whether or not it is read.
- Roughly $0.26–$0.50 for a simple Message Ad, $0.50–$1.20 and up for an interactive Conversation Ad. Reported open
  rates 35–50%. Verify live rates in Campaign Manager before budgeting.
- **The UK is eligible; the EU is not.** LinkedIn restricted EU member targeting for Sponsored Messaging from
  December 2021 and stopped delivery to EU members in January 2022, following the ePrivacy consent ruling. Our
  81-practice list is UK, so it qualifies. Any future EU list does not.
- **No API needed.** Campaign Manager runs these by hand. The Marketing API only automates campaign creation, which
  is pointless at 81 leads. Same approval unlocks Lead Gen Forms and Matched Audiences, which is the retargeting item
  above.

### The unofficial route, and what it costs

Every tool that sends organic invites and DMs drives a real logged-in session against LinkedIn's private interface.
All of them breach LinkedIn's User Agreement. What is at stake is the founder's personal profile, not a throwaway
mailbox. Prices are per one LinkedIn account and mix USD and EUR as each vendor publishes them; all need
re-checking at signup.

| Tool | Price, one account | Trial | API | Note |
|---|---|---|---|---|
| Unipile | €49/month flat | 7 days | Yes | Flat up to 10 accounts; also covers WhatsApp, Gmail, Outlook, Instagram, Telegram, calendars |
| Linked API | $69/month, $49 annual | 7 days | Yes | Per seat, so ten accounts is $490; runs a cloud browser and enforces pacing itself |
| HeyReach | $79/sender/month | 14 days | Yes | Per sender |
| TexAu | $79/month | 14 days | Yes, plus MCP | |
| PhantomBuster | $69/month | Trial | Yes | 20-hour execution cap |

Unipile is the floor for anything API-shaped at our size, because it is the only one priced flat rather than per
seat. There is no cheaper API; "cheaper" only exists in the non-API category below.

Unipile's own pacing guidance, which is the safety envelope whichever vendor we pick: 80–100 invites/day and about
200/week on a paid, active account; roughly 15 invites/week on a free account with history; new accounts start tiny
and ramp. Restriction is usually preceded by two or three days of the account behaving oddly rather than arriving
without warning.

### Cheapest way to test the channel, with no code

The test question is narrow — do UK accounting partners accept a connection and reply — and answering it needs no
adapter, no catalogue row and no repo change at all.

| Tool | Cost for the test | Time to send 81 invites | Terms |
|---|---|---|---|
| Waalaxy | €0, free forever | ~27 days (3 actions/day/type) | Free plan, 80 invites/month, no card |
| Linked Helper | €0 within the trial | Fits inside the 14 days | 14-day trial, then $15/month or $8.25/month annual |
| Dux-Soup | $14.99/month | Fast | Trial |
| Closely | $29–49/month | Fast | Trial |
| Dripify | $39–59/month | Fast | Trial |

Waalaxy's free monthly invite budget (80) is almost exactly our list size (81), which makes it a clean zero-cost
option at the price of a six-week answer. Linked Helper's trial gets the same answer in two weeks for the same €0,
at the cost of installing a desktop app. Sources disagree on whether a desktop app on the user's own IP or a cloud
tool behind a fixed proxy is the lower risk; at three to thirty invites a day neither is near the threshold that
actually triggers restriction, so speed is the real difference between them.

During any such test, replies land in the LinkedIn inbox and not in our system. There is no `record_reply` and no
ladder. The numbers get logged by hand. That is the point: the test buys information, not automation.

### Decision

1. Test first, with no engineering: run the 81 UK practices through a free trial, measure accept rate and reply rate.
   If accept rate is low or replies are zero, LinkedIn dies for €0 and no adapter is ever written.
2. If it converts, Unipile at €49/month is still the right buy for wiring into the engine — the test does not change
   that, it only stops us paying before we know.
3. Message Ads by hand in Campaign Manager is the zero-risk parallel experiment, and the Marketing API application is
   worth starting early regardless because it also unlocks Lead Gen Forms and Matched Audiences.

Open question before any of this starts: how many of the 81 practices have a LinkedIn profile on file at all. That
may be the real blocker, and it is cheap to check.

### Update 2026-09-17 — decision reversed: build it ourselves, no Unipile

The PM decided against renting Unipile (or any vendor). The engine itself now plays Unipile's
role for LinkedIn: it stores each connected account's browser session cookie encrypted and
calls LinkedIn's own internal web API ("Voyager") directly. The engine is product-agnostic,
so every product on it can connect LinkedIn accounts, the way products connect Gmail
mailboxes today; TeamGrid is only the first. This supersedes the "Unipile at €49/month is the
buy" conclusion above. The full build plan is in `docs/linkedin-channel-plan.md`.

Connection method A (ship first): the account owner pastes their own logged-in browser
session — `li_at` and `JSESSIONID` cookies plus the browser user agent — captured from
DevTools. No password, no vendor. Method B (the credentials-plus-email-code screen Unipile
shows) is the "soon" second door; it needs a server-driven login and hits captcha, so it
waits.

P1 built and verified 2026-09-17: `src/adapters/channel/linkedin/` (endpoints, session,
client, adapter), a `cookie` auth type and a `session` transport, a `linkedin` catalogue
entry, the connect action `createLinkedInChannel` (verifies the session with a live `me()`
call before storing anything), a health rule, and the connect drawer with the risk warning
and consent tick. Proven: a real pasted cookie calls Voyager and returns the account's
profile and provider id (`npm run linkedin:check`).

Write ops confirmed 2026-09-17 by capturing the real requests from a live session and
re-issuing them through the client. All four are wired with the confirmed shapes; DM and
comment were run live end-to-end and succeeded (a message started a conversation, a comment
returned its urn). Key findings:
- **Invite**: `POST /voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`,
  body `{invitee:{inviteeUnion:{memberProfile:"urn:li:fsd_profile:<id>"}},customMessage?}`.
  Target is an `fsd_profile` urn; `me()` returns `fs_miniProfile` with the same id, so it is
  rewritten (`fsdProfileUrn`).
- **Comment / reply**: `POST /voyagerSocialDashNormComments?decorationId=…NormComment-43`,
  body `{commentary:{text,attributesV2:[],$type:…TextViewModel},threadUrn}`. A reply is the
  same call with `threadUrn` set to the parent comment's urn
  (`urn:li:comment:(activity:<postId>,<commentId>)`) instead of the post's activity urn —
  there is no separate parent field.
- **DM**: `POST /voyagerMessagingDashMessengerMessages?action=createMessage`, sent as
  `text/plain`, body carries `mailboxUrn` (our own fsd_profile urn), `hostRecipientUrns`
  (the recipient), a UUID `originToken` and a 16-random-byte `trackingId`.
  `hostRecipientUrns` starts or reuses the 1-to-1 conversation, so no conversationUrn is
  needed for a first DM.

Still stale: `profileBySlug()` (URL slug → provider id). The old REST `networkinfo` /
`profileView` endpoints now return HTTP 410; the modern GraphQL profile call needs one more
capture. Not on the send path once the engine stores the id, so it is P2 work. The
`x-li-track` `clientVersion` (currently 1.13.46685) rotates and lives in `endpoints.ts`.

### Gaps and what to build

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| LI1 | Accept rate and reply rate for LinkedIn on this segment are unknown, and every downstream decision depends on them | No LinkedIn sending of any kind | Run the 81 UK practices through a free trial (Linked Helper 14-day, or Waalaxy free), log accept and reply rates by hand | todo, no code |
| LI2 | Unknown how many of the 81 practices have a LinkedIn profile on file | Lead sheet in `docs/leads` not checked for it | Count profiles present; decide whether enrichment is needed before the test is meaningful | todo |
| LI3 | The ladder assumes send-then-wait-for-reply; LinkedIn has a two-step gate | Actions resolve on reply or timeout | A `pending_accept` state that resolves by polling, not by inbound mail: invite with a 300-character note, poll for acceptance, DM on accept, withdraw and fall back to email after ~30 days | todo, blocked on LI1 |
| LI4 | `channelKey` promises `linkedin`, `in_app` and `push` with no catalogue row or adapter behind them | Enum in `src/schemas/common.ts` | At minimum add a `soon` catalogue entry with `waitingOn`, so the roadmap is visible rather than the enum lying | todo |
| LI5 | Retargeting is not modelled: we hold 356 old form leads and 81 practices and only ever send to them | No audience concept | Matched Audiences sync (hashed emails) via the Marketing API, so the brand is seen while mail lands. Zero deliverability and ban risk, costs ad budget | todo, needs budget decision |
| LI6 | Message Ads are available to us today and untried | Nothing | Run one Campaign Manager Message Ad campaign to the UK list by hand, budget around $40, as the zero-risk comparison against the organic test | todo, needs budget decision |
| LI7 | Marketing Developer Platform approval takes four to eight weeks at best and nothing has been submitted | No application | Submit the application now so the clock runs; it unlocks Lead Gen Forms and Matched Audiences as well as ads automation | todo |
| LI8 | Whatever tool is chosen, LinkedIn caps are far tighter than email and the governor is not tuned for them | `sendGovernor` has `dailyCap`, `perHour`, `warmupDay` — the right knobs, wrong numbers | On the LinkedIn channel: daily cap well under 80, weekly ceiling, warmup ramp from a handful per day | todo, blocked on LI3 |

---

## 2026-09-16 — What email programs that get replies actually do (web research)

Source: 2026 benchmark reports and studies read on the web — Instantly and Apollo on cold-email reply rates, Martal and Belkins on subject lines, Stripo's automation benchmarks, Google and Yahoo bulk sender rules. Read against our own record: 97 emails sent, 12 opens (measured on only 28 of them), 4 clicks, 0 replies.

### What the evidence says

- **Deliverability decides everything else.** Compliant senders average 89% inbox placement; non-compliant senders have 22 to 34% of mail routed to spam. Gmail wants spam complaints under 0.1% and never above 0.3%. SPF, DKIM and DMARC are expected of any bulk sender.
- **Signals beat personalisation tokens.** Generic role and firmographic mail replies at 1 to 3%; mail triggered by something that just happened replies at 5 to 18%.
- **Triggered beats scheduled.** Behaviour-triggered sends run about 70% higher open rates and roughly 150% higher click rates than batch sends; automated flows carry the majority of email revenue.
- **The follow-up is where the replies are.** Optimal sequences run 4 to 7 touches over 14 to 21 days, and the first follow-up alone adds 40 to 50% more replies.
- **One ask.** A single call to action draws far more clicks than an email carrying several; a one-word reply ask is the lowest-friction version of it.
- **Shape.** Bodies of 50 to 125 words; subjects of 28 to 50 characters, two to seven words; a number in the subject lifts opens; a company name lifts them, and a specific metric about the reader lifts them further; first-name-only personalisation no longer differentiates.
- **Small batches beat blasts.** Campaigns to fifty or fewer recipients reply better than campaigns to a thousand.
- **A good 2026 cold reply rate is 3 to 5%, strong is above 5%, and 10% is excellent.** Zero from 97 is a content and deliverability problem, not bad luck.

### What the engine does today

Sequencing, per-lead planning, small batches, one-click unsubscribe and a bandit over welcome variants are already right. The gaps are that mail goes out from a domain without DMARC, opens are measured on a minority of sends, every mail carries two asks (trial button plus a postscript about a call), no mail carries a number or an asset, subjects name the product or the feature, and product events do not trigger anything.

### Gaps and what to build

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| EM1 | Non-compliant senders lose a third of their mail to spam | teamgrid.ai has no DKIM or DMARC | Publish SPF, DKIM and DMARC before the next campaign; watch the complaint rate against 0.1% | todo, blocking |
| EM2 | Opens measured on 28 of 97 sends, so no subject can be judged | Pixel only where consent allows | Instrument every send that may carry it, and grade subjects on clicks and replies rather than opens | todo |
| EM3 | Signal-triggered mail replies 5 to 18% against 1 to 3% | Form answers and site text sit unused in copy | Trigger on what we already hold: the problem they typed, team size, timeline, a click, register_started without signed_up | todo |
| EM4 | One ask per mail | Trial button plus a call postscript | Ask ladder: a reply for the first two touches, one button after that, never both | todo, extends 54 |
| EM5 | Subject shape | "Welcome to TeamGrid", feature names | 28 to 50 characters, a number or their metric, the brand where it earns the open; two variants per template, sampled | todo, extends 52 |
| EM6 | Body length | 130 to 200 words of description | 50 to 125 words, one idea, one number with a source | todo |
| EM7 | Triggered beats scheduled by a wide margin | Nothing fires on product events | Product event pipe, then speed-to-lead and abandoned-signup flows | todo, same as 37 and 20 |
| EM8 | 4 to 7 touches over 14 to 21 days | Plans run 5 steps at 1, 2, 2, 3, 3 days | Keep the shape, and add the two-week re-ask rather than ending at last call | todo |

---

## 2026-09-16 — Brainstorm: scenario mails for Indian founders (CEO feedback)

Source: the CEO's review of the lead mails, relayed by Dhaval ("the mail content is still basic"), and teamgrid.ai read on 2026-09-16: home, Productivity Scoring, Hourly Breakdown, App & Website Tracking, Email Insights, HRMS and the Resource Optimizer (Managed Services) page.

Context: the reader is the founder, CEO, HR head or operations head of a 10 to 500 person Indian company. The mails describe features. The CEO wants each mail to open on something that happens in the reader's own week, for example a paid AI tool most of the team does not use, a nine-hour day with a few focused hours in it, or time going to work nobody needed. Dhaval's three starting examples map to ideas 2, 5 and 8 below.

Status: Dhaval approved the whole idea bank for use in mails on 2026-09-16, expecting better reach than the feature mails. Every idea below is approved; an idea whose Source says verify still needs the product team to confirm the feature or number before a mail quotes it. Ideas 49 to 88 were added the same day after reading the pricing, CRM, Ask TeamGrid, edtech and virtual support pages.

### How each mail is built

1. **Their situation**: one scene from a founder's week, in their words ("calls five managers at 8 PM to ask what happened today").
2. **What it costs**: rupees or hours. Rupees land best with Indian founders because they think in salary cost.
3. **What TeamGrid shows**: the one feature that makes the scene visible, ideally with a sample screen.
4. **One ask**: the trial button.

### Rules for these mails

- **Roles, not names.** We do not know the reader's staff, so "your employee Ayush" reads as a guess or a fabrication and breaks the no-names rule. Write "your senior developer" or show a screen clearly marked as sample data. Screens that name real people stay paused (RL9).
- **Never state the reader's numbers before they install.** Use "in a typical 50-person team" with either a teamgrid.ai benchmark or plain arithmetic labelled illustrative (RL5). No invented statistics about Indian employees.
- **Check proof before quoting it.** The site testimonials (Ananya Sharma, Rahul Mehta, Priya Nair), "500+ companies" and the benchmarks (+32% focus hours, 6.2 hours per manager per week, 92% of risks early, 80% fewer stale threads) need confirming with the product team first.
- **Subjects avoid "monitoring", "tracking employees" and "productivity score"** (RD6). Idea 19 is therefore titled by what TeamGrid never records.
- Professional register, no contractions, "Best regards, The TeamGrid Team".

### Idea bank

Source column: `site` is a number shown on teamgrid.ai (sample or benchmark), `illustrative` is worked arithmetic to be labelled as such, `verify` needs the product team to confirm the feature or number, `none` carries no number.

#### Money leaks

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 1 | Salary for nine hours, focused work for five | 50 people at ₹40,000 a month is ₹20 lakh; if three of nine hours go to idle time and meetings, about ₹6.7 lakh a month buys no work | Productivity Scoring, Hourly Breakdown | illustrative |
| 2 | You pay for AI tools. Who is using them? | The company pays for ChatGPT, Copilot or Cursor seats, and most of the team still does the work by hand | AI Tool Radar, App Tracking | verify |
| 3 | The client who costs more than they pay | A ₹50,000 retainer quietly takes 60 team hours a month; common in CA firms, agencies and IT services | Project and client hours | illustrative |
| 4 | Four tools, one ₹649 seat | A dollar-billed time tracker, an HRMS, a CRM and Excel for timesheets | One platform: CRM and HRMS come with the Advanced plan at ₹649 per seat, not Standard at ₹299 | site pricing |

#### Time leaks

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 5 | The best hour is 11 AM, the worst is after lunch | A daily average hides an 85% morning and a 40% afternoon; the standup sits on the peak hour | Hourly Breakdown | site sample |
| 6 | Operations spent two days of last week in meetings | 41% of the week in meetings, twice the company baseline, rising three weeks running | Meeting Load | site sample |
| 7 | The 8 PM status calls | The founder phones every manager each evening for an update | AI Summaries, Founder's Report on Monday at 9 AM | site: 6.2 h per manager per week, verify |
| 8 | Where the afternoon goes | YouTube, Instagram and cricket scores, read as a pattern to understand, not a person to punish | App categories, smart alerts | none |
| 9 | Work that waits two days between two desks | Design hands work to engineering and it sits for 2.4 days | Org Intelligence hand-offs | site sample |

#### People risk

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 10 | The resignation you did not see coming | Activity fell 35% two weeks before; a 90-day notice plus a replacement hire costs lakhs | Engagement Radar, Early Warning | site: 3 weeks earlier, verify |
| 11 | Three people carry 70% of the work | The best people burn out and leave first | Workload, Org Intelligence | site sample |
| 12 | Silent overtime | After-hours work at three times the normal level comes before burnout | Anomaly Feed | site sample |
| 13 | Leave that lands before every deadline | Monday leaves, leave every seventh working day, a stretched Diwali break | Leave Patterns | site sample |
| 14 | Attendance shows who came in, not who worked | Biometric offices and work-from-home teams alike | Automatic attendance from activity | none |
| 15 | Appraisals from twelve weeks of data, not memory | April and October cycles decided on recall and loud voices | Score trends, per-team baseline | none |

#### Clients and revenue

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 16 | A client email has been waiting since Monday | Slow replies are the first sign a client is leaving | Email Insights reply-lag radar (metadata only) | site: 80% fewer 48 h threads, verify |
| 17 | The CRM nobody updates | The sales team lives on calls and WhatsApp | Self-writing CRM | verify |
| 18 | Three days of month-end payroll chasing | Attendance kept in Excel leads to salary disputes | Auto timesheets, payroll export | none |

#### Trust and proof

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 19 | What TeamGrid never records | Staff quit over screenshot tools; India's DPDP Act favours collecting less personal data | No screenshots, no keystrokes, email metadata only | none |
| 20 | A 300-person manufacturer in Gujarat | Operations spent 127 hours a week on manual work; now 11, saving ₹10 lakh a month | Managed Services audit (use for "book an audit" mails only, not the ₹299 app) | site case, verify |

#### Growth and founder visibility

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 21 | At 15 people you saw everything. At 60 you do not. | The founder used to sit beside everyone; now work reaches them through two layers of managers | Org Intelligence, Founder's Report | none |
| 22 | Before you approve two new hires | A manager asks for headcount while three people run at 1.6 times the baseline and others sit below it; two hires at ₹6 lakh CTC is ₹12 lakh a year | Workload | illustrative |
| 23 | Sales blames operations. Operations blames sales. | Each team says the other is slow; the hand-off data shows where orders actually wait | Org Intelligence hand-offs | none |
| 24 | One question from the airport lounge | A travelling founder gets ten "Sir, update?" messages; one question answers "how is the Pune project going" | Ask TeamGrid, mobile | verify mobile |
| 25 | Two offices, one view | Ahmedabad and Bangalore offices plus remote staff in tier-2 cities, each reported differently | Team Activity, attendance present and remote | none |
| 26 | The Monday MIS report that takes a full day | Someone builds the founder's Excel MIS by hand every week; the Gujarat case went from 6 hours to 12 seconds | Founder's Report, Reports | site case |

#### Cost and billing

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 27 | Engineers on the bench are still on the payroll | IT services firms carry non-billable hours between projects | Project tracking, utilisation | illustrative |
| 28 | Forty software seats, eleven people used them | Canva, Zoho, Adobe and AI seats renew every year for people who never open them | App Tracking | illustrative, verify |
| 29 | Overtime claims that nobody can check | BPO and operations teams claim overtime from self-reported hours | Auto timesheets from worked time | none |
| 30 | The client asks how many hours your team put in | Agencies and IT services argue over invoices with no record to show | Hours per project, exports | none |
| 31 | Fixed-price project, open-ended hours | A fixed bid overruns and nobody knows until delivery | Project tracking, Early Warning | none |
| 32 | A contractor invoice for 160 hours | Contract and freelance teams bill hours nobody can see; a record is fair to both sides | Automatic time tracking | none |

#### People and HR

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 33 | The one person who knows how the system works | If they resign on a 60-day notice, the knowledge walks out with them | Org Graph: who work routes through | verify |
| 34 | New joiners who leave in the first 90 days | The first month is spent waiting on access with no buddy and falling engagement | HRMS onboarding checklist, Engagement Radar | none |
| 35 | The quiet performer who never gets noticed | Credit goes to the loudest person, and the steady contributor leaves | Score trends against the team baseline | none |
| 36 | Office or home: where does your team focus better? | The return-to-office debate is argued on opinion | Attendance present and remote, Focus Time | verify the cut exists |
| 37 | US clients, Indian nights | Teams on US and UK shifts carry after-hours load that nobody sees | Shift Planner, after-hours anomaly | none |
| 38 | Your AmbitionBox reviews after a screenshot tool | Employer ratings fall after a surveillance rollout (Reddit research, 2026-09-15); staff see their own data here | Employee self-view, no screenshots | none |

#### Clients, sales and deadlines

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 39 | Leads from IndiaMART and Meta ads that nobody called back | Paid leads sit for 48 hours before anyone replies | Lead Routing skill, Reply SLA Keeper, CRM | verify, Lead Routing shows "learning" on the site |
| 40 | You heard the deadline slipped on the day it was due | The slip was visible on Wednesday and reported on Friday | Goals and Tasks progress from activity, Anomaly Feed | none |
| 41 | WhatsApp Web open all day | Constant chat leaves no focus block; the cause is interruptions, not laziness | Focus Time, Focus Protector skill | none |

#### Automation

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 42 | Twelve things someone does by hand every Monday | Recurring chores repeat because nobody sees the pattern; a skill trimmed two standing calls and gave 2.5 hours a week back | Skill Library | site sample |
| 43 | Distraction is often a symptom | Distracting time rose 2.4 times right after the support queue spiked; fix the queue, not the people | Smart alerts | site sample |

#### Segment hooks

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 44 | Tax audit is due on 30 September. Which clients are taking the hours? | CA firms in filing season; also GST returns on the 20th and ITR on 31 July | Billable hours per client | none; expires 2026-09-30, check for an extension |
| 45 | Per-seat billing to your client, with proof for every seat | BPO and KPO firms bill clients per FTE | Utilisation per seat | none |
| 46 | Staff at a client site, attendance without a biometric | Staffing firms deploy people they cannot see | Automatic attendance | verify |
| 47 | Set up without an IT department | Most SMEs have nobody to roll out software | One installer for Mac, Windows and Linux, five minutes | site |
| 48 | Data residency for regulated teams | NBFC, fintech and health teams need to know where data sits | SOC 2 Type II, ISO 27001, on-site data residency | verify India region |

#### More money leaks

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 49 | The Monday review meeting costs ₹6 lakh a year | Twelve managers for two hours at about ₹500 an hour of salary is ₹12,000 a week | Meeting Load | illustrative |
| 50 | What one focused hour costs your company | A ₹40,000 salary is about ₹200 per paid hour, but about ₹360 per focused hour when five of nine hours are focused | Productivity Scoring, Hourly Breakdown | illustrative |
| 51 | Rent for 100 desks. How many are used on Friday? | About ₹10 lakh a month of office rent while hybrid attendance leaves desks empty on some weekdays | Attendance present and remote by weekday | illustrative, verify rent and the cut |
| 52 | Less than one cutting chai a day | Standard is about ₹14 per working day per person; Advanced is about ₹30 | Price anchor | site pricing, illustrative |
| 53 | Before you cut costs, find the hours going nowhere | Cost pressure pushes towards headcount cuts before anyone knows where the time goes | Hourly Breakdown, Meeting Load, Workload | none |
| 54 | After the funding round, headcount doubled. Did output? | A funded startup hires fast and burns runway without seeing what the new hires changed | Score trends, Workload | none |

#### Sales pipeline

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 55 | A ₹3.1 lakh deal nobody has touched in five days | Deals go quiet in the gaps between meetings, and nobody notices until the buyer has chosen someone else | CRM quiet-account alerts | site sample, Advanced |
| 56 | Your won deals share a rhythm | Won deals had a first touch within 2 hours, a demo inside 4 days and follow-ups every 48 hours; lost deals averaged a 3-day first touch | CRM pipeline patterns | site sample, Advanced |

#### Managed Services (audit ask, not the trial)

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 57 | ₹40 lakh stuck in unpaid invoices | Payment reminders depend on one accountant remembering; the Gujarat case cut overdue invoices by 94% with reminders at 7, 14 and 30 days | Invoice Tracker built by Managed Services | site case; ₹40 lakh illustrative |
| 58 | The same order typed into Tally, Excel and the CRM | Three systems kept in step by hand; the Gujarat case removed 15 hours a week of entry | CRM auto-sync built by Managed Services | site case; Tally is our example |
| 59 | Follow-ups to 200 dealers, sent by hand | Distributor and dealer follow-ups depend on who has time; the case raised response rates by 34% | Email follow-up automation | site case |
| 60 | Move three sliders and see what manual work costs | 87 people at ₹30,000 with 9 automatable hours a week comes to about ₹9.6 lakh a month | The resource optimizer calculator page | site calculator |
| 61 | Which jobs in your company should AI do first? | Everyone talks about AI and nobody knows where it pays; the audit maps three to five areas | Free 30-minute audit, Ask TeamGrid "where are we losing time to manual work?" | site |

#### AI at work

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 62 | You ran an AI workshop. Did anything change the week after? | Training money spent, with no way to see whether usage moved | AI Tool Radar before and after | verify |
| 63 | Which AI tools is your team already using? | Staff use personal AI accounts for company work; TeamGrid sees which tools are open, never what was typed | App and website tracking by domain | verify, never claim content |
| 64 | Four tools for every support ticket | Handling time rose 18% because agents switch between four tools per ticket and copy between the CRM and billing | Ask TeamGrid weekly answer | site sample, Advanced |

#### Fair people decisions

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 65 | When your best person asks for a raise | The founder wants to say yes quickly and keep them, but has only impressions | Score trends, Workload | none |
| 66 | Who is ready to lead a team? | Promotion goes to the most visible person instead of the one others already route work to | Org Graph, collaboration signals | verify |
| 67 | A performance plan built on facts both sides can see | Improvement plans turn into arguments because the evidence is memory; the employee sees the same data | Twelve-week trends, employee self-view | none |
| 68 | A new manager who knows the team on day one | A new manager spends a month learning who does what and when the team works best | Org Memory ("Design does deep work before noon") | site sample, verify |
| 69 | Hire in Indore, manage from Bangalore | Salaries are lower in tier-2 cities, but founders hesitate to hire people they cannot see | Automatic time tracking, AI Summaries | illustrative, verify salary gap |
| 70 | The night-shift agent nobody has spoken to in nine days | Isolation on night shifts shows before a resignation does | Team cohesion, isolation risk | site sample (virtual support) |
| 71 | Forty "forgot to punch" requests a month | HR spends mornings approving attendance regularisation | Automatic attendance from activity | illustrative, Advanced |
| 72 | Wedding season leave, planned before it happens | November to February leave clusters around family weddings and deadlines slip | Leave Patterns, Holidays | none, Advanced |
| 73 | Your team will ask whether this is spying. Here is a page to forward. | The founder's biggest fear is the team's reaction | Employee explainer page: what is and is not recorded | needs the page (RD2) |

#### Operations and quality

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 74 | Same issue, 12 minutes for one agent and 2.6 hours for another | Customers feel the spread; coaching goes to a generic scorecard instead of the step that costs time | Quality consistency on like-for-like issues | site sample (virtual support) |
| 75 | The SLA breach you found out about at month end | Tuesday afternoons ran slow for weeks before the report said so | Response-time trends by queue and shift | site sample |
| 76 | The approval that holds everything for a week | Work waits on one senior reviewer; in edtech, drafting takes 3 days and academic review 7 | Stage-level tracking | site sample (edtech) |
| 77 | Shift handovers that nobody writes down | Handovers between shifts drop to 78% documented and issues fall between them | Handover tracking | site sample |
| 78 | Two teams that have not worked together in three weeks | Operations and sales drift into silos | Org Intelligence silo alert | site sample, Advanced |
| 79 | When a number drops, the reason is already in your data | "Why did support slow down in May?" or "which projects slipped this week, and why?", answered in seconds | Ask TeamGrid | site sample, Advanced |

#### Offer and risk

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 80 | When the trial ends, nothing is charged | Founders fear a card on file and a surprise bill; the workspace pauses and data stays exportable for 30 days | Trial terms | site pricing |
| 81 | Start with one team, not the whole company | A company-wide rollout feels like a big decision | A pilot on one team | none |
| 82 | Guess your team's focused hours, then check | Reply with a guess; a week of trial shows the real number | Reply ask, then Hourly Breakdown | none |
| 83 | What you will see on day one, day three and day seven | Trials stall because nobody knows what to expect; the first pattern appears the next day | Trial timeline | site ("see your first pattern tomorrow") |
| 84 | Billed in rupees, with a GST invoice | Indian finance teams want input tax credit and no dollar card charges | Rupee billing | verify GST invoice |

#### More segments

| # | Working subject | Their situation | What TeamGrid shows | Source |
|---|---|---|---|---|
| 85 | Law firms: the hours that never reach the invoice | Associates rebuild billable time from memory at month end | Automatic time per matter | illustrative |
| 86 | Design studios: revision rounds that eat the fee | Architecture and interior projects run past the fee on unbilled revisions | Project hours | none |
| 87 | US healthcare billing teams in India | Revenue cycle teams need hours per client and HIPAA-ready handling | Hours per client, compliance | verify HIPAA |
| 88 | Recruitment agencies: sourcing time versus admin | Recruiters spend the day on trackers and follow-ups instead of candidates | App and time breakdown | verify |

### Which plan each idea needs

Standard (₹299) covers productivity scoring, hourly breakdown, app and website tracking, attendance and auto timesheets, daily AI summaries, and goals and tasks. Advanced (₹649) adds Ask TeamGrid, Pattern Intelligence, the Anomaly Feed and early warnings, Email Insights, CRM, HRMS and the weekly Founder's Report. Enterprise adds data residency, SSO, roles and audit log. A mail must not promise an Advanced feature at the Standard price: ideas 4, 7, 9 to 13, 16, 17, 23, 26, 33, 39, 40, 55, 56, 64, 68, 71, 72, 78 and 79 lean on Advanced features, and 48 needs Enterprise.

### Ideas we will not use

- **Catching moonlighting.** TeamGrid cannot see a second job, and the mail would accuse the reader's staff.
- **Long lunches, tea breaks, bathroom time.** Breaks turned into evidence is the top complaint from measured staff (Reddit research, 2026-09-15).
- **Field sales and site staff.** The agent runs on computers only.
- **Choosing whom to lay off.** Uses the data against people and contradicts "patterns, not people".
- **Named leaderboards or attacks on named competitors.** Breaks the no-names rule and the competitor rule.

### Dated hooks for India

| When | Hook | Ideas |
|---|---|---|
| Now to 30 September | Tax audit filing | 44 |
| October and November | Diwali leave, half-year appraisals | 13, 15 |
| January and February | Attrition after bonus payout, next year's hiring plan | 10, 22 |
| March | Year-end close, headcount approvals | 22, 26 |
| April to June | Appraisals and increment letters, attrition after them | 15, 10, 35 |
| March to May | IPL | 8 |
| July | ITR filing | 44 |
| 20th of each month | GST return | 44 |
| October and November | Diwali bonus split | 15, 65 |
| November to February | Wedding season leave | 72 |
| June to September | Monsoon work-from-home days | 36, 51 |
| End of each quarter | Sales push, quiet deals | 55, 56 |

### Gaps and what to build

| # | Finding | Engine or content today | Build | Status |
|---|---|---|---|---|
| IN1 | The CEO finds the mails basic; a scene from the reader's own week is what lands | The seven `feature_followup` emails describe features | Write the top seven ideas as emails in the `feature_followup` family (situation, cost, what TeamGrid shows, trial button) so the planner can pick them per lead | todo, waiting for Dhaval's pick |
| IN2 | Rupee cost is the strongest framing for Indian founders | No mail carries a worked number | Illustrative calculation asset built from the team size on the form (63 of 65 leads have it): team × assumed salary × share of the day, labelled illustrative | todo, extends RL5 |
| IN3 | Several ideas rest on claims nobody has checked | Site benchmarks, testimonials and some features unverified | Confirm with the product team: AI Tool Radar output, Lead Routing and Reply SLA Keeper status, mobile app, the office-versus-remote focus cut, Org Graph single points of failure, India data residency, testimonials, "500+ companies", the +32%, 6.2 h, 92% and 80% benchmarks, and for ideas 49 to 88: AI Tool Radar before and after, Org Graph promotion signals, Org Memory, GST invoices, HIPAA, and the hours figure (the home page says 12M+ analysed hours, the pricing page 3M+) | todo, verify |
| IN4 | Dated hooks lift relevance | Dated hooks exist for the UK only (AOS6) | Indian calendar hooks with an expiry date, from the table above | todo, extends 57 |
| IN5 | Segment ideas only fit their segment | Classification can misfile a lead (the Pune property firm filed as `eng_leader`) | Tag each idea with its segments; the planner offers only matching ideas and falls back to the general ones | todo |
| IN6 | Named people in a scenario read as fake | Copy rule exists; some screens still name people (RL9) | Roles in copy; anonymised sample screens only | todo, extends RL9 |
| IN7 | Many ideas rely on Advanced features, and the first draft of idea 4 priced CRM and HRMS at ₹299 | Templates do not record which plan a claim needs | Tag each idea and template with the plan it needs; a mail quoting ₹299 must not promise an Advanced feature | todo |
| IN8 | Idea 73 needs something to forward | No employee-facing explainer exists | One page on teamgrid.ai for employees: what is recorded, what never is, what they see | site task, extends RD2 |

---

## 2026-09-16 — Decision: rolling planner, Claude-written mail, learning across leads

Source: discussion with Dhaval after the scenario idea bank. Full design and build plan in `docs/rolling-planner.md`.

What was decided:

- Claude writes the whole email for each lead and invents the scenario. The idea bank above is the quality bar, not a menu. Truth is the only hard limit, enforced in code.
- Claude chooses plain text or HTML per email and says why; results are counted by format. Plain-text links get click tracking first, or the comparison is blind.
- One frame template (`written_email`) replaces one template per idea. The seven feature emails stay only as the fallback when Claude is late.
- No month-long plans. Claude plans the next one or two touches, the engine watches the result (email 48 hours, WhatsApp 24 hours, call 2 hours, or at once on a click or reply) and asks for the next plan.
- Every touch carries theme, hook, format, ask and lead group, frozen at send. Maintain turns results into learning notes that the next lead's card shows, so what worked for lead B reaches lead C.
- Channels: email now; WhatsApp and Bolna join as per-touch channel choices later.
- Everything waiting in the three lead campaigns is skipped and replanned under the new approach; Dhaval is not approving any of it.

### Gaps and what to build

| # | Build | Status |
|---|---|---|
| RP1 | Text-link click tracking; theme, hook, format, ask and group on every action | done |
| RP2 | Rolling advance: checkpoint after the watch window or a signal, fallbacks at 12 h and 6 h | done |
| RP3 | plan_goal (≤2 steps, theme), compose_batch (whole email, format), lead_card writing brief, save_learning | done |
| RP4 | Theme results by lead group, learning notes, Maintain analyst | done |
| RP5 | Frame template, product writing brief, campaigns switched, pending mail skipped and replanned | done |
| RP6 | Routine prompts pushed to the claude.ai triggers | done |

---

## 2026-09-17 — What respected senders do in plain-text email (web research)

Source: web research on 2026-09-17 into how mail apps show text/plain and what cold-email tools, email platforms and plain-text senders do. Read: Microsoft and Apple support pages, Unicode's emoji data (version 18.0), Litmus, Campaign Monitor, Mailchimp, HubSpot's plain versus HTML tests, Boomerang (40 million emails), Gong (304,000 emails), lemlist, Instantly, Woodpecker, Nielsen Norman Group, GMass, and Google's sender rules. Asked by Dhaval after the written layout went live, to make plain-text mail more appealing before touching HTML again.

### How mail apps show plain text

- **Gmail shows plain text in a proportional font** and offers no fixed-width option, so anything lined up with spaces falls out of line. Column alignment is not possible.
- **Outlook joins lines** ("We removed extra line breaks") by default. A blank line between blocks is never removed. A short line ending in `.` `?` `!` or `:` is kept, and so is a line starting with two spaces or a tab. A line of 40 or more characters with no end punctuation pulls the next line up into it.
- **Hard wrapping at 76–78 characters leaves ragged lines on a phone.** Each paragraph should go out as one line and let the app wrap it. Ours already does (quoted-printable).
- **There is no separate preview line in plain text.** The inbox preview is the first words of the body, so after the short greeting the opening sentence is the preview text.
- **Tracked links show in full** in plain text, and Gmail and iOS also turn addresses, phone numbers and dates into links.
- **Some symbols turn into colour emoji on phones.** These never do: → • – × ÷ ₹ ─ ━ ✓ ✗ ★ ● ① ►. These can: ✔ ☑ ✖ ➡ ↔ ▶ ▪ ⚠ ™. These always are: ✅ ❌ ⭐ ❗. "Unicode bold" (𝗯𝗼𝗹𝗱) is a known spam trick and screen readers spell it out letter by letter.

### What the evidence says works

- **50 to 125 words, one to three questions.** Boomerang's 40 million emails: one to three questions drew 50% more replies. lemlist puts the best length around 120 words and Instantly under 80.
- **One easy question.** Gong's 304,000 cold emails: a low-effort interest question beat asking for a meeting, and ROI language cut replies by 15%.
- **Plain beats designed.** In HubSpot's tests the HTML version with images drew 21% fewer clicks, and a single image already lowered them. Litmus found plain text won with customers and made no difference with others.
- **No links and no tracking in a first touch.** lemlist and Instantly both say tracked links and pixels hurt inbox placement, and that bot clicks make click data unreliable. They measure replies instead.
- **Numerals, not words.** Nielsen Norman Group's eye-tracking: digits catch the eye even in text the reader skips ("5 days", not "five days").
- **The P.S. is read.** It is the recommended place for one extra line, though the popular "90% read it first" figure has no primary source.
- **Opt-out as a sentence.** Woodpecker words the opt-out as an easy reply. Gmail still requires the one-click unsubscribe header from bulk senders, which we already send.

### What we checked and will not use

- CAPS section labels and `*asterisk*` or `_underscore_` emphasis. Gmail and Apple Mail show the symbols literally, and capitals read as shouting in a professional register.
- Unicode bold letters, columns aligned with spaces, and hard-wrapped lines.
- Newsletter habits such as reply-with-a-number options, weekday timelines and dividers. No primary evidence was found, so they are worth testing but not assuming.

### What the engine does today

The written layout (commits 9796a97 and e164543) already puts parts on separate lines with blank lines between them. The cost lines and the list start with two spaces, which keeps Outlook from joining them. It never hard-wraps, sends the one-click unsubscribe header, and suppresses a lead who replies "unsubscribe" or "remove me". It stops at emoji. The gaps:

- Writers spell out numbers ("five days", "nine hours").
- A cost line is one long "situation → result" line that wraps mid-arrow on a phone.
- The preheader a writer supplies is invisible in plain text.
- A plain-text mail may carry a link, which shows as a long tracked vercel.app address.
- The opt-out line prints a 110-character vercel.app URL.
- Emoji-prone symbols are not refused.
- The word cap is 125 plus 15 when structured.

### Gaps and what to build

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| PT1 | Digits catch the eye | Numbers spelled out in copy | Writing rule: numerals for every quantity that carries the point; compose_batch warns on a number word before a unit | done 2026-09-17 |
| PT2 | Long lines wrap badly on phones; no columns | One "label → value" line | Render each cost line as two lines, the situation then "→ result", each short | done 2026-09-17 |
| PT3 | The opening is the inbox preview | Preheader written but unused in plain text | Opening under 90 characters, not a repeat of the subject; the preheader is used only for HTML | done 2026-09-17 |
| PT4 | No links or tracking in first touches | Text mail may carry a tracked link | Plain text asks for a reply only; a link ask goes out as HTML | done 2026-09-17 |
| PT5 | Opt-out as an easy sentence | 110-character vercel.app unsubscribe URL | "Not useful? Reply 'remove me' and we will not write again." plus a short link on the sending domain; header kept | done 2026-09-17, short link on the app domain until a link domain on teamgrid.ai exists |
| PT6 | Some symbols become emoji | Only emoji refused | Allow → – × ÷ = ₹ • ✓ ─; refuse ✔ ☑ ✖ ➡ ▶ ▪ ⚠ ™ and Unicode bold letters | done 2026-09-17 |
| PT7 | 50 to 125 words | 125 + 15 words | 125 words for the whole body including the list lines | done 2026-09-17 |
| PT8 | Unproven patterns worth a test | Layout is tagged on every send | Test as layout variants: reply-with-a-number options and weekday timelines for story ideas (a divider was left out: two tests at once already split a small list) | running since 2026-09-17 |
| PT9 | Plain-looking HTML (Superhuman, Buffer, HEY) gives bold words without looking designed | HTML means logo, card and button | Decide whether a third format, HTML with no logo or card, is worth adding | done 2026-09-17: format `letter` |

---

## 2026-09-17 — Research: Indian office pains and competitor reviews, for short "no way" emails

Source: web research on 2026-09-17, done after Dhaval said the reveal emails were too long. He asked for emails that are very simple, in an Indian business tone, and that make the reader say "I cannot believe it shows that". reddit.com, G2, Glassdoor and AmbitionBox were blocked, so Reddit voices came from news articles quoting them. Also read: Blind (India), Capterra and Trustpilot reviews of Time Doctor, Hubstaff, Insightful, ActivTrak, DeskTime and We360, the Microsoft Work Trend Index, a Slack/Qualtrics survey, and Indian business press (DNA, The Register, Business Today, Storyboard18, People Matters). This builds on the 2026-09-15 Reddit research above. Re-open each link before quoting a line publicly.

### Pains, in order of strength

| # | Pain | Evidence | What TeamGrid shows |
|---|---|---|---|
| 1 | Leaders doubt that WFH or hybrid days are real | CEO quote: "Work-from-home doesn't mean you can work one hour and claim eight" (DNA). Microsoft India survey: 91% of leaders unsure, 93% of employees say they are productive | When work starts and stops, hour by hour |
| 2 | People who look busy | Slack/Qualtrics: Indian workers spend 43% of their time on "performative work", the highest of all countries surveyed | Focus in teal, idle in grey, and a score for each hour |
| 3 | Chasing status | Blind (India): managers "pinged me every 30-60 minutes"; "Are you there? Reply to me." | A written summary for each person by 6pm |
| 4 | Calls eat the day | Microsoft (global): an interruption every 2 minutes; 57% of meetings are ad hoc | Meetings shown in blue |
| 5 | Moonlighting fear | Premji: "cheating, plain and simple"; the LawSikho case drew backlash | Start and stop times, idle hours. Never promise that it detects a second job |
| 6 | Always-on WhatsApp | "Be active on WhatsApp"; 88% contacted after hours (Indeed survey) | When each person's day really ends |
| 7 | Screenshot tools feel like a prison | Time Doctor review: "made team feel like prisoners"; Blind: "creates constant anxiety" | No screenshots, no keystrokes |
| 8 | Calls marked as idle | Insightful review: "idle time recorded during meetings"; Cognizant's ProHance marks idle after 5 minutes | Meetings kept apart from idle; breaks pause on their own |
| 9 | Attendance disputes | A BMC salary withheld because the fingerprint scanner failed; an overtime dispute settled in 2 hours | Start time recorded automatically |
| 10 | Too much data | Insightful review: "No one has a time to go through these video recordings" | One written paragraph a day |
| 11 | "Where does the time go?" | We360 and ActivTrak reviews | Apps and websites per hour |
| 12 | Dollar pricing | Time Doctor review: "$20 per user… adds up"; Hubstaff review: "nickel and dime" | ₹299 per user, 7-day trial, no card |

### Words people really use

"Are you there?", "any update", "be active on WhatsApp", "can you stay on the call?", WFH, moonlighting, late mark, half day, missed punch, attendance regularisation, biometric, CTC, LPA, appraisals.

Not verified as common usage: "sir, update?", "EOD report", "Monday review", "chai break".

### What to avoid

- Spy words: monitor, track employees, catch, spy, stealth, bossware.
- "AI caught…"
- Labelling a person as unproductive, or using an activity percentage as a verdict.
- Implying the team cheats, or praising hustle (70-hour weeks).
- Treating idle as an accusation.
- Promising moonlighting detection.

### Gaps and what to build

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| IN-R1 | The reveal emails ran to 145–170 words with three maths lines and a card; Dhaval found them too heavy | Hot emails: 170 words, receipt required | A short hot shape: one phrase they say every day, one surprising truth, one line on what TeamGrid shows, one safety line, one button, in 50–80 words. The receipt card only in "the hour" email | proposed, examples shown 2026-09-17 |
| IN-R2 | Their own words make the pain real | No phrase list | `writing.phrases`: the verified Indian office phrases above, offered to the writer | proposed |
| IN-R3 | Measured third-party figures land harder than our examples | Examples only | `facts.external`: Slack 43% performative work (India), Microsoft 91/93%, Indeed 88% after-hours contact, each with its source; usable with the source named | proposed |
| IN-R4 | Competitor pain is the easiest contrast | Not used | A contrast line without naming the tool ("screenshot tools", "tools that mark a client call as idle") | proposed |
| IN-R5 | Spy and verdict words trigger backlash | Some are avoided | Add catch, spy, monitor employees, bossware, unproductive employee to `wordsAvoid` for hot emails | proposed |

---

## 2026-09-18 — Research: what works on LinkedIn for B2B outreach (web; Reddit second-hand)

Asked while planning the LinkedIn channel: what actually works for a B2B SaaS on LinkedIn in 2025–2026, and what gets
an account restricted. Reddit blocked every tool, so its views here come through blogs that quote it and through Indie
Hackers posts. Most numbers are vendor-reported (Expandi, Belkins, SmartReach, Waalaxy, La Growth Machine) and lean
towards "automation works"; LinkedIn's own help pages are the only independent source on limits.

### What the evidence says

- A free account can add a note to only 3 invites a month (LinkedIn help). Blank invites are accepted slightly more
  often (27.6% vs 25.3%, Belkins, 15M touches) but a note lifts replies after the accept (8.2% vs 5.3%).
- A note naming a real tie is accepted far more: "thanks for the follow" 81% against a 30% baseline (Expandi); one
  founder saw 61% citing the person's post against 18% for "I'd love to connect".
- The first message after an accept does best at 151–200 characters (8.5% replies; 201–300 fell to 5.9%). Three
  messages beat one (9.8% vs 6.3%) and five or more do worse (5.0%). Gaps of 3–5 days.
- No pitch and no link in the first message; one soft question. Pitching straight after the accept is the complaint
  practitioners repeat most.
- Automated warm-up (profile view, like, follow) adds about 1.5 points. A real comment on the person's post before
  inviting lifted one founder from 24% to 58% accepted.
- LinkedIn and email together: about 3× the meetings of LinkedIn alone (SmartReach, 500k invites). Sequence used by
  lemlist: email day 1 and 4, invite day 7 to non-openers, message the day after an accept, back to email if no accept.
- Limits: about 100 invites a week and under 20–25 a day (LinkedIn help; hitting it restricts for about a week).
  Acceptance under about 25% is what gets accounts limited. Mornings (07:00–11:00) in the lead's zone are accepted
  more (32–37% vs 23% in the evening). Withdraw invites pending over 3 weeks.
- AI-written invites were accepted 12% less often than human ones; profile compliments, several questions and reused
  wording read as automated. LinkedIn may hide comments made through automation tools (since August 2025).
- Posting 2–5 times a week is where reach steps up; people who engaged with a post reply at 15–25% against 5–10% cold.
- India: about 150M members; buyers check with people they trust, and read WhatsApp before LinkedIn. UK accounting:
  73% of firms turn work away for lack of staff; Making Tax Digital for Income Tax went live in April 2026.

### What the engine does today (after 2026-09-18)

- Invite, message, comment and reply calls confirmed against a live session; per-action limits rising weekly; random
  2–9 minute gaps; a dead session holds the queue and turns the channel red; a lead is looked up once.
- The channel's rules live in `src/channels/rules.ts` (engine defaults) with per-product overrides in
  `product.config.channelRules`, so a second product needs settings, not code.
- Not yet: seeing an accept or a reply, Claude planning and writing for LinkedIn, warm-up comments, email fallback.

### Gaps and what to build

| # | Idea | Engine today | Build | Status |
|---|---|---|---|---|
| LI1 | Blank invites on a free account | Every invite carried the note | `capabilities.inviteNote` set from the account's plan at connect; blank invites clear the words | done 2026-09-18 |
| LI2 | Mornings in the lead's zone | No hours on LinkedIn | Channel `policy.quietHours` [11, 7] from the rule set, enforced at send; replies exempt | done 2026-09-18 |
| LI3 | Under 20 invites a day, 100 a week | 30 a day | Invite cap 10 rising to 20, 100 a week | done 2026-09-18 |
| LI4 | Lists of profiles with no email | Rows dropped (keyed on email) | A sheet with a LinkedIn column and no email column is keyed on the profile slug | done 2026-09-18 |
| LI5 | Every signal says its channel and the touch that drew it | Replies had neither | `channel` and `actionId` on reply events; channel shown on the lead timeline | done 2026-09-18 (email); LinkedIn signals in L1 |
| LI6 | See accepts and replies | Neither | Accept check against the newest connections every 3–5 hours at random; messages wait for it; reply handler built. The inbox read waits on a live capture of the messaging requests | accepts done 2026-09-18; replies todo (L1b) |
| LI7 | Withdraw after 21 days, pause below 25% accepted | Neither | 21 days unaccepted stops the lead's LinkedIn messages; invites pause below 25% of the last 50 and lift on their own; the withdraw call itself needs a live capture | done 2026-09-18 except the withdraw call |
| LI8 | Claude plans and writes LinkedIn messages | Email-shaped tools only | Routine 6 with `linkedin_card`, `pick_linkedin`, `plan_linkedin`, `answer_linkedin`; refusals for length, one question, link timing, profile compliments, sign-offs, company names, reused sentences, repeated ideas; email routines untouched | built 2026-09-18 |
| LI9 | Real comment before the invite, approved by a person | None | Comment step drafted by Claude, held in Review | todo (L3) |
| LI10 | LinkedIn and email in one sequence | One channel per campaign | One campaign across channels, Claude picks the channel per step from the lead's history | todo (L4) |
| LI11 | Founder posts, commenters as warm leads | None | Content routine; engagers become a source | todo (L3) |

---

## 2026-09-21 — Loss-first mails: what goes wrong, what it costs, what TeamGrid does

Source: Dhaval's review of the teamgrid_leads_v3 queue on 2026-09-21. There were 65 mails waiting: 64 needed approval and 1 was queued. He found them too soft ("not only positive positive"). He asked for mails that show what the client loses today in money and time, and what TeamGrid catches and fixes, one capability at a time, "aggressively". This came together with the new email illustrations that show negative findings with numbers (public/email-illustrations/insights/).

Context: the 65 waiting mails open on a gentle observation ("Paid hours and focused hours are rarely the same number") and show one sample line. They never say plainly what the founder is losing or what TeamGrid would have caught.

Status: 21 draft mails written, one per capability. They are ideas 89 to 109 and are shown on public/email-content-loss/index.html. They are not yet in the live idea bank (`config.writing.ideas`), and no waiting mail has been rewritten. Both wait for Dhaval's approval.

### How each mail is built

1. **The problem**, stated plainly: "You pay for 9 hours. Right now you cannot see how many are real work."
2. **What TeamGrid found**, as a sample: minutes on named sites, idle time, late logins, hours in calls.
3. **What it costs**: rupees or hours, worked out in simple arithmetic and labelled "example".
4. **What TeamGrid does**: three short lines, taken only from `facts.canDo`.
5. **What you get back**: one line.
6. **One button.** The P.S. carries the trial terms.

### Rules kept

- Professional register, no contractions, sentences of 20 words or fewer, "Best regards, The TeamGrid Team".
- Roles, not names, in the mail text. Names appear only on sample screens.
- The reader's own numbers are never stated. Every figure is either "sample" (a screen) or "example" (arithmetic), or comes from a named outside source (Slack/Qualtrics 43%).
- No claim from `facts.unverified` (+32% focus, 6.2 hours, 500+ companies). No ROI promise.
- Advanced-plan features carry the plan and ₹649 in the mail.
- Subjects avoid "monitoring", "tracking employees" and "productivity score".

### What changes from the 2026-09-17 rules

- The 2026-09-17 research said: do not treat idle time as an accusation, and do not use an activity figure as a verdict. These mails put the lost time first, on purpose, because Dhaval asked for it. Mails still never say "catch", "spy" or "unproductive employee", and each one repeats the no-screenshots line.
- IN-R1 asked for 50–80 words. These run 87–133 words because each carries a cost block. Trim before use where the format caps at 125.

### Idea bank additions (draft)

| # | Subject | Their situation | Cost line | Capability | Plan |
|---|---|---|---|---|---|
| 89 | You pay for 9 hours. How many are work? | You pay your team for 9 hours a day. Right now you cannot see how many of those hours are real work. | If 3 of 9 hours are not work: ₹6.7 lakh a month paid for no work | Active, idle and focus time (desktop app) | Standard |
| 90 | 2 hours a day of YouTube, on your payroll | Every team loses time to YouTube, Instagram and shopping sites. Nobody sees it, so nobody fixes it. | 10 people like this: ₹88,000 a month | App and website categories: productive, neutral, distracting | Standard |
| 91 | 4 hours of calls. 1 hour of work. | Your managers are busy all day. But a day full of calls is not a day of work done. | 5 managers: ₹1.75 lakh a month in calls | Hourly breakdown: meetings, focus, idle | Standard |
| 92 | Longest stretch of work today: 14 minutes | WhatsApp pings, "quick call?" and "any update?" cut the day into small pieces. Hard work needs long quiet stretches. | So it moves to late evenings: or it slips | Focus time, hour by hour | Standard |
| 93 | Stop the 8 PM "any update?" calls | Every evening you call or message each manager to ask what happened today. Half the answers are "working on it". | And the answers: are still guesses | Daily AI work summary by 6 PM | Standard |
| 94 | Biometric shows who came in. Not who worked. | A punch at 9:30 says someone reached the office. It does not say when work started. For work from home, you know even less. | Plus HR time: fixing attendance by hand | Attendance from real activity, no punch clock | Standard |
| 95 | 3 days of payroll chasing, every month | At month end, HR chases timesheets, leave records and "half day" arguments. Payroll waits for all of it. | Late payroll: an unhappy team | Automatic timesheets, leave, shifts and payroll export (HRMS) | Advanced |
| 96 | The client who costs more than they pay | Some clients take far more hours than their fee covers. You find out at renewal, or never. | Loss on this one client: ₹14,000 a month | Hours by project and client, no timesheets | Standard |
| 97 | Appraisals on 12 weeks of data, not memory | Most raises are decided on memory and on who speaks loudest. The quiet person doing the most work often gets the least. | A strong person who feels ignored: leaves | Productivity scores and 12-week trends per person | Standard |
| 98 | Idle time doubled. Nobody told you. | People rarely resign without signs. Work slows, idle time grows, late nights pile up. Nobody connects it until the resignation mail arrives. | Plus the months: a new person needs to learn the work | Early warnings: activity falling, after-hours rising | Advanced |
| 99 | A few people are carrying your whole team | In most teams, a few people do most of the work. They are also the ones who burn out and leave first. | Their work lands on others: and deadlines slip | Workload per person, uneven workload flag | Advanced |
| 100 | A client email has waited since Monday | A client writes on Monday. By Thursday nobody has replied. You hear about it when the client complains, or leaves. | Lost over slow replies: all of it | Email Insights: reply wait by team and client | Advanced |
| 101 | The deal that went quiet two weeks ago | A lead asks for a quote. The follow-up slips. Two weeks later the deal is gone, and nobody can say when it went cold. | Five like it in a quarter: ₹15 lakh | CRM that logs activity and alerts when a deal goes quiet | Advanced |
| 102 | Which project slipped this week, and why? | Today, to learn why a project slipped, you ask four managers and wait a day. Each one tells a different story. | Answers based on opinion: not on what happened | Ask TeamGrid: plain-language questions | Advanced |
| 103 | Your whole week on one page, every Monday | The Monday review takes the whole morning. Six managers read out numbers from six Excel sheets. | 4 Mondays: about 48 hours a month | Weekly Founder's Report | Advanced |
| 104 | Leave that lands before every deadline | Some leave follows a pattern: Mondays, the day before a deadline, the week after a hard review. Nobody sees the pattern in a leave register. | Others cover the work: and get tired | Leave patterns (early warnings) | Advanced |
| 105 | 43% of the workday goes to looking busy | A Slack survey found that Indian workers spend 43% of their working time on work that only looks busy. That was the highest of all countries surveyed. | If your team matched the survey: ₹8.6 lakh a month goes to looking busy | Active time, focus and apps: real work vs looking busy | Standard |
| 106 | Overtime claims nobody can check | Overtime is paid on what people write down. Some of it is real. Some of it is a laptop left open. | For 20 people: ₹1.2 lakh a month, unchecked | After-hours active time and automatic timesheets | Standard |
| 107 | 4 tools, or one ₹649 seat | Many teams pay for a time tracker billed in dollars, an HRMS, a CRM, and still keep timesheets in Excel. None of them agree with each other. | Data that never matches: hours of fixing every month | One platform: time, HRMS and CRM | Advanced |
| 108 | Install today. See the gaps tomorrow. | You do not need a long rollout to see where time goes. One small app on each computer is enough. | Trial: 7 days, no card | 5-minute install, first report next morning, 7-day trial | Standard |
| 109 | No screenshots. You still see the lost hours. | Screenshot tools make a team feel watched, and good people leave. But without any tool, you cannot see the lost hours at all. | Camera: never | Privacy: no screenshots, no keystrokes, employees see their own data | Standard |

### Gaps and what to build

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| LF1 | Waiting mails are too soft to earn attention | 65 waiting mails in teamgrid_leads_v3 open on gentle observations | Rewrite in template 4 only the leads the soft mails are not reaching: in-profile leads with two or more mails sent (or one opened) and no click. 25 of 65 rewritten on 2026-09-21; welcome, closing, off-profile and early-stage mails left as they were. The old mail is kept on each action under `before` | done 2026-09-21, awaiting review |
| LF2 | The writer is never told to lead with the loss | `voice.do` asks for one problem and one feature | Add to `voice.do`: "state what the reader loses today in rupees or hours before naming the feature; show one sample finding" | proposed |
| LF3 | Ideas 89–109 are not in the live bank | 88 bank ideas and 10 invented ones | Added to `config.writing.ideas` with hook, proof, keywords, pattern, also and their picture key | done 2026-09-21 |
| LF4 | Payroll, email waits, CRM, Ask TeamGrid, Founder's Report, leave and overtime mails have no picture | Illustrations exist for 9 topics | 11 more insight pictures drawn (attendance, payroll, client, workload, emailwait, deals, ask, monday, leave, overtime, tools) in public/email-illustrations/insights/ | done 2026-09-21 |
| LF5 | The first drafts repeated the picture's numbers in the text (Dhaval: "basically repetition of data") | Three formats: text, letter, designed | A fourth template, "picture + short text": the picture carries the findings; the text gives only the cost in rupees or hours, what TeamGrid does, what you get back and one button, in 65–89 words. Drafts for all 21 ideas on public/email-content-loss/picture.html | built 2026-09-21, then folded into Designed the same day at Dhaval's request: still three versions (Designed, Letter, Plain text). A message with `action.picture` is designed as the picture mail (`renderPicture`); the letter and plain text never carry the picture, and the text never refers to it. The AI pick is per lead: designed where the lead has opened our mail before, letter where they have not. The 20 pictures are in `config.email.pictures`. Optional per mail, never a bulk switch |

---

## 2026-09-21 — lemlist, probed end to end (competitor)

Source: lemlist.com, lemlist.com/pricing and a 14-day trial account, walked page by page on 2026-09-21. We asked its AI agent (lemAgent) to plan a TeamGrid campaign for founders of Indian IT services firms with 50–200 people, searched its people database for the same audience, opened the campaign builder, settings, inbox, reports, deliverability, signal agents, enrichment, tasks, calls and the AI context center, and generated a company context from teamgrid.ai.

What lemlist is: a sales outreach tool built around a 650M-contact database, a visual sequence builder (email, LinkedIn, calls, SMS, WhatsApp) with condition branches, and a deliverability suite. Price: $69 a month for email only; multichannel is $109 per user a month ($87 yearly); WhatsApp and credits cost extra.

What we saw:

- **Finding leads.** One sentence found 5,837 founders of Indian IT services firms with 51–200 people. Emails and phones are found per lead for credits, through a waterfall of 25+ data providers.
- **AI agent.** It wrote a sensible brief and one fixed sequence for everyone: LinkedIn visit, invite, three emails and a gate on "invite accepted". The plan included a "Pune founder story" that TeamGrid never gave it, so it looks invented. Creating the campaign needs a paid plan, and the message carousel's next button did not work.
- **Builder.** A canvas with "wait N days" on each step and Yes/No branches. Clicking a step opens its editor on the right. Before launch, errors show on the broken step. Steps include email, LinkedIn visit, invite, message, voice note, InMail, like, follow, comment, endorse and withdraw, plus WhatsApp, SMS, call, manual task, API call and send-to-campaign. Conditions include opened, clicked, replied, accepted invite, booked a meeting, has email, has phone and is connected.
- **Campaign settings.**
  - On click, reply or meeting: continue, pause or end the lead, and pause everyone at the same company.
  - AI scores the tone of a reply and handles out-of-office replies.
  - Timezone-based schedule, sender rotation and matching the email provider.
  - Tracking switches, with warnings that tracking hurts deliverability.
- **Deliverability.**
  - Warm-up (lemwarm) and inbox-placement tests you can schedule.
  - Bounce rate by provider, mailbox and domain.
  - Alerts with thresholds, a tech-setup audit, and domains and mailboxes you can buy.
- **Signal agents.** 20+ buying signals: website visitors, job changes, hiring, funding, LinkedIn engagement with competitors or influencers, tech changes, news. The "Engage" and weekly "Optimize" agents say "Coming soon", so their learning loop is not live.
- **AI context center.** Paste the website and it writes one readable document:
  - overview and positioning;
  - offerings, value proposition, segments and personas;
  - markets and pains;
  - a map of the site's feature, solution, comparison and pricing pages;
  - mission and security claims;
  - customer stories. It copied the site's testimonials as if they were real.

  It is used by every AI feature. Our product setup already goes deeper on truth: plans, what the product never does, unverified claims and the idea bank. We had no page map, proof list, competitors, trust claims or markets, and nothing refreshes it.
- **Everything else.**
  - A unified inbox with interested / not interested / to-unsubscribe filters.
  - Task queues for calls, hot leads and replies.
  - Widget dashboards.
  - Native HubSpot, Salesforce and Pipedrive integrations.
  - An API, an MCP server and a CLI.
  - A meeting recorder.

Where the engine is ahead:
- a plan for each lead, not one path for all;
- learning across leads through the idea bank;
- the review queue;
- one URL building config, brand, templates and campaigns;
- AI voice calls;
- WhatsApp through the official API;
- branded letter and designed mail;
- pacing by lead type;
- pre-send validation that refuses invented proof.

Decisions (Dhaval, 2026-09-21 and 22):
- No in-app AI chat box: the routines do that work.
- Finding leads and writing back to the CRM are future scope.
- Own buying signals, team invites and roles come later.
- The UI/UX pass comes after the feature work.
- Company context v2 is first.

| # | Finding | Engine today | Build | Status |
|---|---|---|---|---|
| CX1 | A context read from the whole site: page map, proof, competitors, trust, markets | `add_product` fills one line, value props, segments, voice and forbidden claims; the truth sheet and ideas are filled by hand; nothing maps the site | `config.context` (schemas/product.ts), `read_site` (sitemap or home links, then page text; JavaScript-built pages read through a rendering reader, `SITE_READER_URL`), `save_context` (every page and source on the product's own site, segments must exist, proof always saved as sample, previous context kept in audit) | done 2026-09-22 |
| CX2 | A mail's button can go to the page that fits the lead | Every button goes to the start link | `link_page` on compose_batch, checked against the page map; `mergeVarsFor` sends the button and every link in that mail to the page, with the person and visit token | done 2026-09-22 |
| CX3 | Writers see the context | lead_card shows facts, ideas and examples | `writing.context` on lead_card, cut to the lead's segment, with rules: facts win over the site, sample proof is only an example and never named, competitors only when the lead uses one. Same context on linkedin_card, and link_page on plan_linkedin and answer_linkedin; the Advance and LinkedIn routine prompts name link_page | done 2026-09-22 |
| CX4 | The context goes stale when the site changes | Nothing reads the site again | `setup_gaps` raises `no_context` and `context_stale` (30 days); Maintain 5.1 reads the site again and records what changed; a conflict with facts goes to the owner | code done 2026-09-22; the Maintain trigger prompt needs pushing after deploy |
| CX5 | A person reads and confirms the context | Only as raw JSON on Settings | A Context page: sections, proof to confirm, page map | todo, UI pass |
| CX6 | Campaign rules: pause the company on a reply, out-of-office, stop on a meeting | Seven reply intents; none of the three | `engine/campaignRules.ts`: a hold on a lead's campaigns until a date (`holdUntil`, `holdReason`, `holdKind`) that fireDue waits out without losing approval and advance/plan requests/nudges skip. A real reply by email, WhatsApp or LinkedIn holds colleagues at the same company (not free-mail domains) for 14 days. An out-of-office reply (Auto-Submitted, X-Autoreply or an automatic-reply subject) is recorded as `auto_reply`, not a reply, and holds the lead until 09:30 IST the day after the return date it names (Indian date order), or one week. A booking on our page or a `booked` event from the customer's site skips what was waiting and stops the sequence; a meeting sales logs in the CRM does not (decision 2026-09-21). Shown on the lead page and in Review. `npm run verify:rules` | done 2026-09-22 |
| CX7 | Deliverability basics | SES DNS only; bounces recorded, never watched | DNS check for any domain, email check before the first send, bounce auto-pause, own tracking domain, rented warm-up | todo |
| CX8 | One reply stream across Gmail, WhatsApp and LinkedIn | Replies live on each lead's timeline; LinkedIn inbox read is off | Replies page (`/replies`, `engine/replies.ts`): every reply of the last 90 days with Claude's tag and the answer, in states Needs an answer / Answer drafted / Answered / No answer needed / Automatic; approve or reject a drafted answer there, Mark done for one answered outside the engine; count in the side menu. LinkedIn replies appear once inbox reading is on (CX9). `npm run verify:replies` | done 2026-09-22 |
| CX9 | LinkedIn fully on | Visit, invite, message, comment | Inbox read, withdraw, like and follow before invite | todo |
| CX10 | Lead database, email finder, CRM write-back | none | — | skip for now: future scope (2026-09-22) |
| CX11 | Own buying signals; team invites and roles | Site events exist (`/api/e`); owner role only | — | later (2026-09-22) |

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
| 37 | Product event pipe from teamgrid.ai (login, session, invite, report, checkout, payment, limit, cancel) — prerequisite for 19, 20, 28, 30, 31 and everything below | Roshan P0 | todo |
| 38 | Lifecycle stages on the person, one stage-campaign at a time | Roshan P1 | todo |
| 39 | Trial-to-paid flow after activation, with abandoned-checkout branch | Roshan P2 | todo |
| 40 | No-login and low-activity churn flows | Roshan P4 | todo |
| 41 | Post-trial flow | Roshan P3 | todo |
| 42 | Achievement milestones flow | Roshan P5 | todo |
| 43 | Feature-limit and annual upsell | Roshan P6 | todo |
| 44 | Cancellation, survey, win-back | Roshan P7 | todo |
| 45 | Payment decline flow | Roshan P8 | todo |
| 46 | Broadcast campaigns to segments with content buckets | Roshan P9 | todo |
| 47 | UTM parameters on every CTA | Roshan P10 | todo |
| 48 | Goals name the revenue variable they move | Roshan P11 | todo |
| 49 | Variants on preheader, CTA and offer | Roshan P12 | todo |
| 50 | Custom-flow checklist and full journey map in docs | Roshan P14, P15 | todo |
| 51 | Insight follow-up family: one problem, one worked number, one framework, one question, soft ask | AOS1, AOS3 | todo |
| 52 | Subject rule: claim, number or question; no "welcome" to non-signups | AOS2 | todo |
| 53 | Three-bucket diagnostic question, reply classified, next mail per bucket | AOS4 | todo |
| 54 | Ask ladder: reply asks before the trial button | AOS5 | todo |
| 55 | Postal address in every footer | AOS8 | todo |
| 56 | Hype guard in validation (capitals, emoji bullets, unsourced multiples, scarcity) | AOS9 | todo |
| 57 | Dated segment hooks with expiry (UK: 31 January self-assessment peak) | AOS6 | todo |
| 58 | Story hook library from Reddit pains, feeding the insight family | RD1 | todo |
| 59 | "What TeamGrid never records" block and employee-facing explainer | RD2 | todo |
| 60 | Diagnostic buckets: memory timesheets, unused timer, resented screenshot tool | RD3, merges with 53 | todo |
| 61 | Segment hooks for accounting, MSP, agencies, offshore teams | RD5 | todo |
| 62 | Cold-copy voice note: no "monitoring" or "productivity score" in subjects | RD6 | todo |
| 63 | Rollout kit for managers after signup | RD4, feeds 19 | todo |
| 64 | Confirm meetings-not-idle and seat minimum, then use as proof lines | RD8 | todo, verify |
| 65 | Comparison pages for Toggl, Clockify, Harvest, Monitask, Teramind | RD7 | site task |
| 66 | Seed TeamGrid asset store: price anchors, stories, sourced stats, calculation, explainer | RL1 | doing: 20 drafts seeded 2026-09-15, awaiting review |
| 67 | Format chosen per touch, recorded, reported; cold default plain text | RL3 | todo |
| 68 | `story` and `analogy` asset kinds with source, checked date, expiry | RL2 | todo |
| 69 | Validator: numbers need a source asset or an "illustrative" label | RL5 | todo |
| 70 | Bandit over angle, asset and format with retirement rule | RL4 | todo |
| 71 | Maintain drafts new assets from research into an approval queue | RL6 | todo |
| 72 | Compose prompt picks an asset per step or states why words alone are better | RL7 | todo |
| 73 | Per-lead brief: their world, their words, team size, objection; analogy from their world, numbers from assets | RL8 | todo |
| 74 | Pause screenshots that name people; replace with aggregate, anonymised blocks | RL9 | todo, needs approval |
| 75 | Publish SPF, DKIM and DMARC, then watch the complaint rate | EM1 | todo, blocking |
| 76 | Measure opens on every eligible send; grade subjects on clicks and replies | EM2 | todo |
| 77 | Trigger copy on the problem they typed, team size, timeline and clicks | EM3 | todo |
| 78 | One ask per mail: reply first, button later, never both | EM4 | todo |
| 79 | Subject shape rule and two sampled variants per template | EM5 | todo |
| 80 | Body of 50 to 125 words with one sourced number | EM6 | todo |
| 75 | Free-trial test of LinkedIn on the 81 UK practices: accept and reply rate, no code | LI1 | todo |
| 76 | Count how many of the 81 practices have a LinkedIn profile on file | LI2 | todo |
| 77 | `pending_accept` ladder state: invite, poll for acceptance, DM on accept, withdraw and fall back to email | LI3 | todo, blocked on 75 |
| 78 | LinkedIn catalogue entry so the enum stops promising a channel with no adapter | LI4 | todo |
| 79 | Matched Audiences retargeting sync from the lead list | LI5 | todo, needs budget |
| 80 | One Campaign Manager Message Ad campaign to the UK list, by hand | LI6 | todo, needs budget |
| 81 | Submit the LinkedIn Marketing Developer Platform application to start the four-to-eight-week clock | LI7 | todo |
| 82 | Tune `sendGovernor` for LinkedIn caps: daily well under 80, weekly ceiling, warmup ramp | LI8 | todo, blocked on 77 |
| 83 | Top seven Indian founder scenarios written as `feature_followup` emails | IN1 | todo, waiting for pick |
| 84 | Verify product claims behind the scenario ideas before any mail quotes them | IN3 | todo, verify |
| 85 | Illustrative rupee calculation from the form's team size | IN2 | todo |
| 86 | Indian dated hooks with expiry (tax audit 30 September first) | IN4 | todo |
| 87 | Segment tags on ideas so the planner offers only matching ones | IN5 | todo |
| 88 | Roles instead of names in scenarios; anonymised sample screens | IN6 | todo |
| 89 | Plan tag on ideas and templates so ₹299 mails never promise Advanced features | IN7 | todo |
| 90 | Employee explainer page to forward | IN8 | site task |
| 91 | Rolling planner end to end: plan 1–2 touches, Claude writes whole mail, learning across leads | RP1–RP6 | done 2026-09-16 |
| 92 | Plain-text shape: numerals, two-line cost lines, opening as preview, symbol allow-list, 125-word cap | PT1–PT3, PT6, PT7 | done 2026-09-17 |
| 93 | Plain text carries no link; short opt-out sentence and link on the sending domain | PT4, PT5 | done 2026-09-17; link domain on teamgrid.ai needs DNS |
| 94 | Layout tests: reply-with-a-number, weekday timeline | PT8 | running since 2026-09-17 |
| 95 | Plain-looking HTML as a third format (`letter`) | PT9 | done 2026-09-17 |
| 96 | LinkedIn: blank invites on free accounts, morning window, 20 invites a day, profile-keyed lists, channel on every signal | LI1–LI5 | done 2026-09-18 |
| 97 | LinkedIn: see accepts and replies; withdraw after 21 days; pause below 25% accepted | LI6, LI7 | accepts, expiry and pause done 2026-09-18; inbox read and withdraw wait on a live capture |
| 98 | LinkedIn: routine 6 plans and writes per lead from the channel's rule set | LI8 | built 2026-09-18; its remote trigger waits on approval |
| 99 | LinkedIn: approved comments before invites; founder posts and their engagers | LI9, LI11 | todo |
| 100 | One campaign across channels; Claude picks the channel per step | LI10 | todo |
| 101 | Loss-first mails: rewrite waiting v3 mails, voice rule, ideas 89–109 in the bank, template 4 (picture + short text) in the engine | LF1–LF5 | done 2026-09-21 except the voice rule (LF2) and letting the writer pick template 4 itself |
| 102 | Company context v2: site map, page text, page map, proof, competitors, trust, markets; writers read it; a button can go to the fitting page | CX1–CX3 | done 2026-09-22 |
| 103 | Monthly re-read of the site by Maintain, with what changed | CX4 | code done 2026-09-22; trigger prompt to push |
| 104 | Context page to read the context and confirm proof | CX5 | todo, UI pass |
| 105 | Campaign rules: company pause on reply, out-of-office, stop on meeting | CX6 | done 2026-09-22 |
| 106 | Deliverability basics: DNS check, email check before first send, bounce auto-pause, tracking domain, rented warm-up | CX7, merges with 12 and 75 | todo |
| 107 | One reply stream across Gmail, WhatsApp and LinkedIn | CX8 | done 2026-09-22 (LinkedIn replies wait on 108) |
| 108 | LinkedIn fully on: inbox read, withdraw, like and follow before invite | CX9, merges with 97 and 99 | todo |
