# Rolling planner: plan a little, watch, learn across leads

Decided with Dhaval on 2026-09-16, after the CEO called the lead mails basic. This document is the design and the build plan. Status of each part is in the last section.

## What changes, in one picture

```
 BEFORE                                            AFTER
 ─────────────────────────────────────────────     ─────────────────────────────────────────────────────
 Claude plans 4–7 emails for a lead at once        Claude plans the next 1–2 touches only
 each step picks one of 7 fixed feature emails     each step is a theme Claude invents for this lead
 Claude writes one opening line (≤45 words)        Claude writes the whole email: subject, preview,
 the template adds fixed feature text                body, P.S., plain text or HTML, reply or button
 every email goes out as HTML                      format is chosen per email, with a reason
 results are counted per template                  results are counted per theme, format, ask and
                                                     lead group, and written up as learning notes
 lead B's result never reaches lead C              what worked for B is on C's lead card next time
```

```
 lead A:  plan 1–2 ─▶ send ─▶ watch ─▶ checkpoint ─▶ plan next 1–2 ─▶ send ─▶ watch ─▶ ...
                               │                          ▲
                               ▼                          │
                  ┌────────────────────────────────────────┴──┐
                  │ results by theme × format × ask × group    │  ◀── every lead feeds it
                  │ learning notes (Maintain, daily)           │
                  └────────────────────────────────────────┬──┘
                                                           ▼
 lead C:  plan 1–2 using what worked for leads like C (and one in three plans tries something new)
```

## Principles

1. **Claude invents the content.** The 88 scenario ideas in `docs/learnings.md` (2026-09-16) are examples of the quality bar, not a menu. The best email is the one that reads like the reader's own week.
2. **Truth is the only hard limit.** No feature TeamGrid does not have, no benchmark or customer result that is not verified, no reader numbers before they install, no person's name, no lead company name, no Advanced feature promised at the Standard price.
3. **Plan the next one or two touches, never the month.** The first touch tells us more than any plan written before it.
4. **Every touch is an experiment with a label.** Theme, hook, format, ask, channel and timing are recorded on the action, frozen at send.
5. **Learn across leads, carefully.** One or two sends are a guess, never proof. Exploration continues across the group so the first winner does not lock in.
6. **The engine enforces, Claude decides.** Anything that must never happen is refused in code; anything that needs judgement is in the routine prompt.
7. **Nothing sends unreviewed** while the campaign is `gate_on`.

## Who does what

```
 ┌──────────────────────────── ROUTINES (claude.ai triggers, prompts in src/engine/routines.ts) ────────────┐
 │ Acquire   1.3 lead-planner: first plan and every checkpoint plan (next_work "plan"), 1–2 steps          │
 │ Advance   2.1 composer: writes each planned touch in full, chooses format and ask, states why          │
 │ React     3.2 on a click or reply: re-plans the next 1–2 at once, leaning into what they engaged with  │
 │ Maintain  5.2 learning analyst: reads results by theme and group, saves learning notes, retires losers │
 └────────────────────────────────────────────▲──────────────────────────────────┬─────────────────────────┘
                                  lead_card    │                                  │ plan_goal, compose_batch,
                                  what_works   │                                  │ save_learning
 ┌────────────────────────────────────────────┴───────── CODE ────────────────────▼─────────────────────────┐
 │ advance.ts    rolling mode: plan exhausted → checkpoint after the watch window or a signal → plan job;  │
 │               no plan in 12 h, or no words in 6 h → an unsent fixed feature email goes instead           │
 │ tools.ts      plan_goal: ≤2 steps, theme per step, frame template; compose_batch: whole email, format,  │
 │               tags, refusals; lead_card: writing brief; what_works: themes; save_learning (new)          │
 │ fireDue.ts    action.templateKey override (fallback), variant tags frozen at send, text-link tracking   │
 │ tracking.ts   click tracking for links in plain-text mail                                               │
 │ outcomes.ts   themePerformance: theme × format × ask × hook × channel × lead group                      │
 └────────────────────────────────────────────▲──────────────────────────────────┬─────────────────────────┘
 ┌────────────────────────────────────────────┴───────── DATA (MongoDB) ─────────▼─────────────────────────┐
 │ products.config.writing   facts (by plan, never does), examples, subjectAvoid                           │
 │ templates                 written_email frame (active); 7 feature emails stay as the fallback family     │
 │ goals.perLeadPlan         { family: "feature_followup", mode: "rolling", frame: "written_email" }       │
 │ goal_instances            checkpointAskedAt                                                             │
 │ actions                   theme, hook, format, formatWhy, templateKey; variant.{theme,hook,format,ask,   │
 │                           group}                                                                        │
 │ learning_notes (new)      finding, group, themes, evidence, status guess / confirmed / retired          │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## One lead, step by step

```
 EVENT                              ENGINE (code)                                  CLAUDE (routine)
 ─────────────────────────────────  ─────────────────────────────────────────────  ──────────────────────────────────
 form arrives                       ingest, welcome sent (fixed, fast), playbook   —
                                    stamped as a placeholder, plan job queued
 within the hour                    —                                              Acquire: lead_card, plan_goal with
                                                                                   1–2 steps (theme, channel, when, why)
 step due                           advance hands a compose job to Advance          Advance: lead_card, compose_batch
                                                                                   (subject, preview, body, P.S., format,
                                                                                   ask, theme, hook, why)
 written                            validate, render through the frame,            —
                                    hold in Review (gate_on)
 approved and sent                  tags frozen on the action, links tracked       —
 watch window (email 48 h,          click or reply ends it early (React also       React: re-plans at once on a click or
 WhatsApp 24 h, call 2 h)           gets an escalate job)                          reply
 plan exhausted and window closed   checkpoint: plan job queued, instance stamped  Acquire: plans the next 1–2
 no plan 12 h after the checkpoint  one unsent fixed feature email goes instead    —
 no words 6 h after a compose job   same fallback, never an empty frame            —
 budget or deadline spent           parked; Close decides the ending               Close
```

## Data model

### Product: `config.writing`

```
writing: {
  facts: {
    plans:       [{ name, price, includes: [..] }],   // what each plan really contains
    canDo:       [{ text, plan }],                      // plain sentences, one capability each
    neverDoes:   [ .. ],                                // safe privacy statements only
    unverified:  [ .. ],                                // site claims not to quote until confirmed
    limits:      [ .. ],                                // honest limits, e.g. computers only
  },
  examples:     [ .. ],   // the scenario ideas: bar, not menu
  subjectAvoid: [ .. ],   // words a subject may not carry
}
```

### Plan step (rolling)

```
{ id, after_days, channel, theme, hook?, format?, templateKey: "written_email", why }
```

`angle` is stored as the slug of the theme, so every existing rollup, the "already ignored" refusal and the lead page keep working.

### Action (new fields)

```
theme       "Evening status calls"        the idea in words, for people
hook        "story" | "rupee_math" | "question" | "comparison" | "proof" | other
format      "text" | "html"               read by fireDue at send (existing override)
formatWhy   one sentence
templateKey fallback override: render through this key (a family picks an unsent member)
variant     + theme, hook, format, ask, group (frozen at send)
```

`group` is `segment|team size band` (`1-10`, `11-50`, `51-200`, `200+`, `unknown`).

### Learning note (`learning_notes`)

```
{ orgId, productId, key, group, finding, themes: [..], evidence: { sent, clicked, replied, won },
  status: "guess" | "confirmed" | "retired", createdBy: "claude", createdAt, updatedAt }
```

Thresholds Maintain applies: below 5 sends it is a guess; 10 or more sends with at least 2 clicks or replies is confirmed; 10 or more sends with nothing is retired.

## Refusals in code

| Where | Refused |
|---|---|
| plan_goal (rolling) | more than 2 steps; a step with no theme; a theme this lead already got and ignored; a template other than the frame or the fallback family; a channel the campaign does not allow |
| compose_batch (frame) | body over 125 words (lists and titles included); the whole mail over 200; no `format`; plain text with a link ask; a link in the body; the lead's company name; a subject word from `subjectAvoid`; a reply ask whose question has no question mark; first person singular |
| compose_batch (written in parts) | an opening over 90 characters or one that repeats the subject; a cost label of 40 characters or more, a cost value or list line over 50; quantities spelled out ("five days"); symbols phones turn into emoji (✔ ▶ ™) and styled Unicode letters; a timeline or reply options against the lead's test arm, or missing where the arm requires them |
| compose_batch (warnings, not refusals) | a number with no "for example" nearby and no asset |
| fireDue | everything it refuses today (opt-out, repeats, gaps, quiet hours, approval) |

## Format rules (prompt, measured in results)

| Situation | Format |
|---|---|
| no click yet, early written touches | text, reply ask, no link |
| reply ask | text |
| link ask, or a bold phrase carries the idea | letter |
| clicked, visited or signed up | letter, or html where a sample, table or screen carries the idea |
| the idea needs a visual (table, sample summary, screen) | html |
| answering their reply | text (already forced) |

Three formats since 2026-09-17: `text` (text/plain only), `letter` (HTML that looks typed: no logo, box or button, client fonts and colours, bold phrases, a link on its own words, rendered by `renderLetter` in `src/engine/html.ts`) and `html` (the branded design). Review offers all three for a written touch.

## Channels

Email now. WhatsApp (Wati) and Bolna calls join as channel choices once the campaign allows them; the checkpoint loop is channel-agnostic and the watch window is per channel. WhatsApp outside the 24-hour window needs an approved template, and calls carry a cost cap; both stay enforced in code.

## Migration of what is waiting (2026-09-16)

1. Switch `teamgrid_leads_v2`, `teamgrid_leads_v3` and `teamgrid_july_aug_leads` to rolling mode.
2. Skip every queued or awaiting-approval email in those campaigns with `skipReason: "replanned under the rolling planner"`.
3. Old plans are treated as exhausted in rolling mode, so every active lead reaches a checkpoint and gets a plan job. Watch windows are counted from their last send, so most are due at once; the queue spreads them across hourly runs.
4. Nothing sends while the campaigns are `gate_on` and nobody approves.

## Testing

1. `npm run typecheck`.
2. `src/scripts/verify-rolling.ts`: pure checks for the checkpoint decision, text-link tracking, the refusal rules and the group band.
3. After deploy, one real v3 lead end to end through the live MCP server: lead_card shows the writing brief, plan_goal accepts 1 step and refuses 3, compose_batch writes a plain-text email, fire_due holds it in Review with tracked links and the tags, and the rendered mail is read back.
4. Routine prompts pushed to the five claude.ai triggers, then one Acquire and one Advance run watched.

## Build status

| # | Part | Status |
|---|---|---|
| 1 | Design doc | done |
| 2 | Text-link tracking, action tags, variant snapshot | done (3cb0b64) |
| 3 | Rolling advance: checkpoint, watch windows, fallbacks, replies answered first | done (3cb0b64) |
| 4 | plan_goal, compose_batch, lead_card, next_work, what_works, save_learning | done (3cb0b64, 3370b17) |
| 5 | themePerformance and learning notes | done (3cb0b64) |
| 6 | Frame template `written_email` (stage `frame`, kept out of the ladder fallback), product writing brief (facts, 88 examples, subjectAvoid), campaigns switched | done 2026-09-16 |
| 7 | Routine prompts and tool lists | done (3cb0b64) |
| 8 | Lead page and Review: idea, format and why; bulk approve keeps the writer's format | done (3cb0b64) |
| 9 | Verify script (`npm run verify:rolling`, 39 checks), typecheck, deploy, live test | done 2026-09-16 |
| 10 | Skip pending mail (33 skipped), replan all active leads (28 new leads urgent, 323 old leads paced at twenty an hour) | done 2026-09-16 |
| 11 | Prompts pushed to the Acquire, Advance, React and Maintain triggers | done 2026-09-16 |

## Live test, 2026-09-16

One real v3 lead (property advisory founder, 11–50 people, "not able to gauge what they are doing whole day"), through the production MCP server:

- lead_card returned the writing brief (their words, facts, 10 examples, group `founder|11-50`) and marked the old plan spent.
- plan_goal refused a 3-step plan and accepted a 1-step plan with the theme "The desk hours between site visits".
- compose_batch refused a subject with "monitoring", a body naming the company, and a frame touch with no format; it accepted a plain-text reply-ask email with no warnings.
- The live tick picked the email up and deferred it to 17 September 08:20 UTC for the 2-day warm gap since the welcome; it will then wait in Review.
- Rendered read-only with the production renderer: plain text, no button (reply ask), unsubscribe link direct, validation clean.

## Routine test, 2026-09-16

- The scheduled Acquire run at 16:34 UTC skipped its lead planner: old refusals in its run history said plan_goal belonged to React. That refusal was real before this build (plan_goal was missing from Acquire's tool list), which is also why about 340 plan jobs had piled up since the morning. The tool list was fixed in 3cb0b64 and the prompt now says so plainly (7e64fe1).
- A manual Acquire run at 16:44 wrote 13 rolling plans, each a single step with an idea invented for that lead (a travel planner: "An itinerary stuck two days before anyone notices"; an events agency: "Calling around to every site lead before you can tell a client what actually happened").
- A manual Advance run at 16:50 wrote 7 of them in full: plain text, reply asks, examples labelled, and the limit stated where the fit was partial (work away from a computer is not recorded). They are queued for 17–18 September and wait in Review.

## Fixes after the first night, 2026-09-17

What the data showed by 04:40 UTC, twelve hours in: 252 rolling plans, 206 whole emails written, nothing sent. Three problems, fixed the same morning (e7af90a):

| Problem | Cause | Fix |
|---|---|---|
| 36 emails went out in the old style (one opening line inside a fixed feature email) | 27 rolling plans named a feature email as the template, which plan_goal allowed; 9 off_icp leads were still on the old playbook | plan_goal now forces the frame on every rolling step; off_icp leads are planned too, as one short question; the 36 were skipped and the 27 plans pointed at the frame, so Advance rewrites them |
| 20 fixed backup emails for old leads | the planner ran at 20 an hour and the old list was paced at 20 an hour, so any slow run pushed leads past the 12-hour wait | the 20 were skipped; the 108 leads still waiting for a plan had their clock restarted; the lead planner and the writer now take 50 per run in waves of 25 |
| 1 email said "the problem you named" | the rule against saying how they arrived did not cover pointing back at the form | compose_batch refuses "you named", "you mentioned", "your form" and similar; the email was skipped and is rewritten |

## Plain-text shape, letter format and layout tests, 2026-09-17

From research into what respected senders do in plain text (docs/learnings.md, PT1–PT9). Built in 71930f6.

- **Plain text.** A cost line renders as the situation, then "→ result" on the line under it, with a blank line between rows. Gmail uses a proportional font, so columns cannot line up, and Outlook joins a long line to the next unless a blank line or end punctuation stops it. Quantities are digits. The opening doubles as the inbox preview. The body is 125 words at most.
- **No links in plain text.** A plain-text touch asks for a reply. The opt-out line reads `Not useful? Reply "remove me" and we will not write again.` with a short unsubscribe link under it. The short link is `/u/<id>.<sig>`: 16 characters of person id and 72 bits of the same signature, redirecting to the full `/api/u` link. The mail header still carries the full link for one-click unsubscribe.
- **Layout tests.** `layoutArm(personId, test)` puts each lead in the use or hold-out arm of each test, for good:
  - `reply_options`: on reply asks, "Reply with one number:" followed by numbered answers.
  - `timeline`: on story ideas, 2 to 4 moments such as "Monday: …".
  lead_card shows the arm under `writing.layout_tests` and compose_batch enforces it. The layout tag records `+options` and `+timeline`, so what_works compares the arms by replies. The frame template has named slots `timeline` (after the opening) and `options` (after the question).
- **Letter.** Chosen per touch like the other formats, recorded on the send variant as `letter`, and offered in the review drawer as its own pill.

## Plain language, 2026-09-17

Dhaval found the written emails right in substance but hard for a normal business owner to follow. They assumed the reader knew what TeamGrid is, and some lines were clever rather than clear. Built in b316ca5:

- `products.config.writing.oneLine` ("TeamGrid shows how your team spends its working day on the computer.") is on the lead card as `writing.product_in_one_line`. Every written touch says it once, usually as the line above what they would see. compose_batch warns when a touch never does.
- No sentence over 20 words (`SENTENCE_MAX_WORDS`, refused).
- `writing.wordsAvoid` pairs hard words with plain ones (sign-off → approval, blocked → stuck, keystroke → what people type), shown on the card as `plain_words`. A touch that uses one is refused.
- Four rewrites Dhaval approved (dealer approval, 9 paid hours, late handover, 8 PM calls) are the model. The 22 teamgrid_leads_v3 emails were rewritten the same day. The older July–August and v2 emails wait for his review of those.

## Lead types, 2026-09-17

Dhaval: the leads in teamgrid_leads_v3 filled in our own ad form, so they are hot and should be pushed to sign up. The system was writing to them like a cold list: a lesson, a question and a 2-day wait. A campaign now says what kind of people it holds, in `goals.leadType`, and `LEAD_TYPE_PROFILES` in `src/engine/rolling.ts` turns that into behaviour:

| Type | Who | Paced as | Watch window | Default ask |
|---|---|---|---|---|
| hot | filled in our own form, asked for a demo, visited pricing | hot (12–24 h gaps) | 24 h | trial link; reply only on hook `closing` |
| warm | clicked an ad, downloaded a guide, just exploring | warm | 48 h | link; reply on `question` or `closing` |
| cold | uploaded or bought list | cold | 72 h | reply question, teach first |
| reengage | old leads gone quiet, expired trials | warm | 72 h | reply question |
| trial | signed up, not paid | hot | 24 h | link; reply on `question` |

- **Pacing.** `effectiveBand(personBand, leadType, formTimeline)` is the band used for due dates in advance, compose_batch and rescheduling.
  - A lead's own reading can make them hotter than their type, never cooler.
  - A dead lead stays dead.
  - Someone in a hot campaign who wrote that they are only exploring is paced warm until they click.
- **Checks.** compose_batch refuses a reply-only touch where the type's default ask is the link, unless the hook is one the type allows.
- **What the writer sees.** lead_card's writing brief shows `lead_type` first, with its rules. The Acquire planner plans two steps for hot leads: the idea as the reason to start, then how short setup is. The Advance writer uses the letter format with the trial link, and a P.S. offering a walk-through when they reply "call".
- **teamgrid_leads_v3.**
  - Set to `hot` with a budget of 7 emails in 14 days, and active deadlines moved to 14 days from start.
  - The 22 plain-language emails were replanned as two hot emails each, for review.
- **Parked.** The payment link and a separate demo booking link, by Dhaval's choice.
- **Still needed.** The signup event from TeamGrid. Without it a lead who signs up keeps getting trial emails.

Found the same day: 18 of those plain-language emails failed at their due time. Nothing was sent. `validate()` exempted only the full `/api/u/` opt-out link, so the short `/u/<id>.<sig>` link in a plain-text reply ask read as a second link. Fixed in 3a0e09f.

## Letter format: white and branded, 2026-09-17

- **White, always.** The letter declared a "light dark" colour scheme and set no colours, so the review's inbox preview on a dark screen showed it black. It now declares light only, with dark grey text on white (8357965).
- **Sender name.** The hello@teamgrid.ai channel had a bare `from`, so inboxes showed the sender as "hello". It is now "TeamGrid <hello@teamgrid.ai>".
- **Branding (032ae44).** Dhaval compared seven layouts and picked one, asking for the logo only twice. `renderLetter(resolved, letterBrandFrom(kit, product))` now builds:
  - the logo and product name on top;
  - the "what you would see" part between two thin grey lines, with the product name in a darker shade of the brand accent and accent ticks (no left border);
  - one button in that shade;
  - a signature with the logo, the name, `config.writing.signatureLine` and the website, placed before the P.S.
  - The problem stays in black bold.
- **Waiting emails.** The 19 letters already held for review were sent back through the approval gate, re-rendered with click tracking and held again. Letters due later render branded when they come due.

## Reveal strategy for hot leads, 2026-09-17

Dhaval brought a stronger pattern, written by Cursor: emails that make the reader think "no way it can show that", instead of explaining the product. Built in 7613d32.

**What changed in the engine**

- **Four beats in every hot email.** A scene with a day or time; a salary number labelled as an example; a day-1 receipt; the privacy twist before the button. compose_batch refuses a hot email with no `receipt` or with a `limit` that does not say no screenshots and nothing typed. The closing email is exempt.
- **Receipt.** A new list style: a grey fixed-width card in HTML, with focus, meetings and idle in the product's colours, and aligned lines in plain text. The frame template has a `receipt` list slot after `shows`. Its title must say it is a sample.
- **Button words.** `cta_text` lets the button carry the reveal: "See the first day", "See your team's hours" or "See a day without watching anyone". "Start your free trial" stays for the hidden-bill email.
- **The hot sequence of jobs.** `hidden_bill`, `the_hour`, `sacred_cow`, `no_watching`, `meeting_bill`, `closing`. lead_card shows it with each job marked sent or not, and the planner plans the next two.
- **Longer hot emails.** Up to 170 words (other types stay at 125), and the whole mail may reach 250 words.
- **Truth checks.** Refused: testimonial-like lines ("founders who install this say…", "customers love…"), and "caught", "wasting", "slacking" or "lazy".

**Checked against teamgrid.ai**

The product facts were checked against the live feature pages for hourly breakdown, automatic time tracking and AI work summaries:

- hourly blocks, each with its own apps, score and summary
- focus in teal, meetings in blue, idle in grey
- start and stop detection, and auto-paused breaks
- the view is live: at 3pm the dashboard shows 3pm
- a summary for each person by 6pm, which they see first
- end-to-end encryption, and "patterns, not people"

The site's sample figures are stored in `facts.samples` and may be quoted only as samples. "idle" was removed from the plain-words list because it is the product's own word.

**What the engine will not claim**

Cursor's draft also had three claims TeamGrid cannot back, and the engine does not use them:

- a founder quote
- "a meeting 4 of them needed"
- team head-counts per activity presented as a product view

## Short no-way emails, 2026-09-17 (replaces the long reveal shape)

Dhaval found the four-beat reveal emails too heavy: about 170 words, three maths lines and a receipt card. He asked for very simple emails that make an Indian founder think "no way, it can do that?". Humor is an occasional add-on, never a style. The colour legend was removed. Built in 565453a:

- **Five blocks, 60 to 110 words.** Their moment (opening, scene); the hidden truth (scene, or one cost line for money); `reveal`; the safety line (`limit`: no screenshots, nothing typed); a short closing line (`question`). Then the button.
- **The `reveal` part** is a named slot in the frame after the cost card. It holds what TeamGrid already knows or does, and the letter sets it between thin lines with the product name in the brand shade. Named slots now keep their name in resolved blocks.
- **Hooks chosen per lead.** `daily_question`, `hidden_bill`, `office_habit`, `just_ask`, `found_out_late`, `no_watching`, `closing`. The planner picks the two that fit best, joined to an idea from the idea bank.
- **Refused by compose_batch in hot emails:** no reveal (or receipt), no safety line, colour or screen words (teal, "in blue", dashboard), and spy or verdict words (time pass, spying, unproductive employee).
- **What the writer sees.** The brief carries `writing.phrases` (Indian office words), `writing.hookExamples` and `facts.external` (Slack 43%, Microsoft 91%, Indeed 88%, each quotable only with its source). The button list grows to name what the reader will see ("See tomorrow's 6pm summary").
- **teamgrid_leads_v3.** The 45 waiting emails were replaced with two no-way emails per lead for review.

## Idea bank on every plan, and sample cards, 2026-09-17

Dhaval asked whether the 88 approved ideas were really used. They were not. No plan step named an idea, and the lead card showed 10 ideas picked at random, so every lead got the same handful of scenes. Built in dd395db and e08b32f:

- **Each idea is tagged** in `products.config.writing.ideas`. The tags are the hook that lands it, `proof` (the verified capability that makes it true), `plan` (Standard or Advanced), `card` (summary, apps, day or none), segments, keywords, and `usable`. 50 of the 88 are usable. The other 38 rest on features that are unverified or not in `canDo`: AI Tool Radar, Org Graph, Org Memory, the Managed Services builds and the Gujarat case figures, among others. Each one says why in `note`. Ideas 10, 11, 12 and 22 carry made-up example numbers, and their notes say so.
- **lead_card `writing.ideas`** (`src/engine/ideas.ts`) ranks the bank for the lead:
  - their words (main problem, role, team size, company site) against each idea's keywords and title
  - their segment
  - a penalty once an idea is planned for 3 or more other leads in the campaign this week, and a large one at 5
  - ideas the lead was already sent go last

  The card shows `best_fit` (the top 8), `others`, `used_a_lot_this_week` and `already_had`. The 10 random examples are gone when a bank exists.
- **plan_goal requires `idea_refs`** on every step when the bank is tagged. It refuses:
  - a step with no ideas
  - ideas that are unknown or unusable
  - ideas this lead was already sent
  - ideas already planned for 5 other leads in the campaign this week

  A blend or a new idea still names the ideas it came from. compose_batch copies the refs onto the action as `ideaRefs`, so what_works can report by idea later.
- **Show, do not describe.** When the idea has a card, a hot email adds `receipt` after the reveal: a title that says it is a sample, and 2 to 4 plain lines. The letter renders it without colours, inside the same thin-line section as the reveal. compose_batch refuses any figure (hours, minutes, times, percentages, counts) that `writing.facts.samples` does not show (`unsampledFigures` in rolling.ts). The nouns may fit the reader's business. Two samples were added from teamgrid.ai: app time for a sample day, and a sample 6pm summary.
- **Routines.** The Acquire prompt says to start from the idea bank, then the hook. The Advance prompt carries the sample card rule. Both triggers were pushed.
- **teamgrid_leads_v3.** The 46 waiting no-way emails were skipped. Each lead was replanned on two ideas from a shortlist reserved for them. The result is 23 leads and 46 emails:
  - 27 different ideas, with no idea used by more than 4 leads (#16, client emails waiting since Monday)
  - 22 emails with a sample card
  - every claim checked against `canDo`

  Three emails explained setup ("start with one team", "5 minutes per computer") instead of giving a no-way moment. They were rewritten on #28 (software seats nobody opens) and #40 (the slip heard on the due date). Ideas #47, #52, #80 and #81 (setup, price and trial reassurance) now carry hook `closing`, so they only go into the closing email.

## teamgrid_leads_v2 merged into v3, 2026-09-17

Dhaval asked to move every v2 lead into v3, give them v3's idea-bank emails, and delete v2.

- **Who moved.** All 31 leads moved. 6 were active; each had a welcome and 1 follow-up from the old qiksteals mailbox. The other 25 were recycled early-September form leads whose only email was "your workspace is ready" on 9 Sep. None was suppressed or in another campaign.
- **How.** Each goal instance was moved in place, so its sent history stays linked. Its `goalKey` became v3 and `movedFrom` was set to v2. It restarted with a 14-day deadline, the v3 check (`account_created`) and the hello@teamgrid.ai channel, for both the instance and the person. The 6 waiting v2 emails were skipped and their step numbers released. The move skipped the welcome, because these people heard from us over a week ago.
- **Emails.** Each lead got a shortlist that counts the ideas v3 already uses, then 2 idea-bank emails. That makes 62 emails, and 25 of them carry a sample card. plan_goal's cap refused one idea that 5 leads already had. Three scenes about a "160-hour contractor invoice" were reworded as examples ("Say a contractor sends…").
- **Deleted.** The v2 goal and its 6 playbooks were deleted. No source pointed at v2. Its 45 finished queue jobs stay as history. Everything is backed up in the session scratchpad (`v2-backup-before-move.json`).
- **Result.** v3 now holds 54 active leads, each with 2 idea-bank emails waiting for review. Idea #13 (leave that lands before deadlines) reached 5 leads in this batch, the cap, so watch it.

## Follow-ups


- Confirm the "verify" items with the product team, then move confirmed ones from `facts.unverified` to `facts.canDo`.
- Watch the first Acquire and Advance runs under the new prompts; the lead planner handles twenty leads an hour, so the old-lead backlog takes about sixteen hours.
- WhatsApp and Bolna as per-touch channels once the campaigns allow them.
