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
| compose_batch (frame) | body over 125 words; the whole mail over 200; no `format`; a link in the body; the lead's company name; a subject word from `subjectAvoid`; a reply ask that does not end on a question; first person singular |
| compose_batch (warnings, not refusals) | a number with no "for example" nearby and no asset |
| fireDue | everything it refuses today (opt-out, repeats, gaps, quiet hours, approval) |

## Format rules (prompt, measured in results)

| Situation | Format |
|---|---|
| no click yet, first two written touches | text |
| reply ask | text |
| the idea needs a visual (table, sample summary, screen) | html |
| clicked, visited or signed up | html |
| answering their reply | text (already forced) |

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
| 2 | Text-link tracking, action tags, variant snapshot | todo |
| 3 | Rolling advance: checkpoint, watch windows, fallbacks | todo |
| 4 | plan_goal, compose_batch, lead_card, next_work, what_works, save_learning | todo |
| 5 | themePerformance and learning notes | todo |
| 6 | Frame template, product writing brief, campaign switch | todo |
| 7 | Routine prompts and tool lists | todo |
| 8 | Lead page and Review: theme, format and why | todo |
| 9 | Verify script, typecheck, deploy, live test | todo |
| 10 | Skip pending mail, replan all active leads | todo |
| 11 | Push prompts to the claude.ai triggers | todo |
