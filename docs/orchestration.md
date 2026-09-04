# Orchestration: what the engine does, what Claude does

Status: built. Last updated 2026-09-04. Everything below is in the codebase and verified by
`npm run verify:orchestration`, which checks it against real data rather than fixtures. The
faults listed under "What was wrong" are fixed; the sending-capacity constraint at the end
is not a code problem and remains open.

This document exists to answer one question precisely: when an organisation has several
products, each product has several campaigns, and each campaign has thousands of people,
what guarantees that every one of those people is worked on, in order, without anyone
being missed and without the model bill scaling with headcount.

The answer has two halves, and keeping them apart is the whole design.

---

## The division of labour

| | Engine (code cron) | Claude (scheduled routines) |
| --- | --- | --- |
| Cadence | every minute, and as often as we like | once per hour, at best |
| Scope | every row, always | a bounded slice per run |
| Cost | flat, near zero | tokens per person touched |
| Determinism | total | judgment |
| Owns | the clock, the queue, the gates, delivery | who someone is, what to say, whether they are done |
| Never | writes copy, classifies, decides strategy | sends, schedules, enforces a limit |

The scheduling platform enforces a floor of one run per hour for Claude routines, and
staggers those runs by a few minutes to spread load. Two consequences follow, and the
architecture is shaped by both:

1. Nothing time-critical may depend on Claude. Suppression on unsubscribe, stopping a
   sequence on reply, honouring a send cap and firing a due message all have to be engine
   work, because an hour is too long to wait for any of them.
2. No routine may assume another routine has just finished. Runs drift. The only safe
   handoff is a durable one, which is why the work queue — not a message between
   sessions — is the interface.

---

## The work queue is the only handoff

`work_queue` began as one job kind (`ingest_rows`). It is now the spine of the system.

```
{
  _id, orgId,
  productId, campaignKey,     // the fairness keys
  kind,                       // classify | playbook | escalate | compose | monitor | groom
  subjectId,                  // personId, goalInstanceId or segmentKey
  priority,                   // 0 urgent, 1 normal, 2 background
  status,                     // queued -> ready -> leased -> done | failed
  dueAt, leaseUntil, attempts,
  cost: { tokensEstimate }
}
```

The engine enqueues. The engine also decides what is `ready`. Claude routines only ever
claim what is already marked ready, do the work, and write their results to the domain
collections — never back to whoever dispatched them.

This is deliberate. Published work on multi-agent orchestration identifies context
overflow in the orchestrating agent as the characteristic failure of the pattern: an
orchestrator that reads what each worker produced accumulates all of it and eventually
exceeds its window. Here the orchestrating step reads counts, not content, and the workers
report to the database. Orchestrator context stays constant whether the system holds one
hundred people or one hundred thousand.

---

## Engine lanes

All of these run on the external one-minute cron that already hits `/api/cron/tick`. They
are cheap enough to add freely; more lanes make the system harder to break, not slower.

| Lane | Job |
| --- | --- |
| A — send | Fire due actions. Round-robin across products and campaigns, sorted by `dueAt`, capped by the channel governor. |
| B — signal | Record clicks, opens, replies and bounces. Recompute temperature. Move the `dueAt` of queued actions when a band changes. Enqueue an escalate item for anyone who moved. |
| C — ingest | Drain uploaded spreadsheet chunks, poll due sources, create people and goal instances, stamp the segment playbook, queue the first touch. |
| D — dispatch | Compute fairness and mark work ready. Detailed below. |
| E — reconcile | Delivery receipts, bounces, budget refunds for messages that never landed. |
| F — watchdog | Any action queued more than two hours past `dueAt` and never fired raises an alert. This is the lane that would have caught the 71 dead actions on the day they died. |
| G — lease reaper | Requeue `work_queue` rows whose lease expired. A Claude session that is killed mid-batch must not take its work with it. |
| H — budget window | Per-inbox hourly and daily counters, and the warmup ramp. |
| I — backlog metric | Queue depth and oldest-item age per campaign, written where the console can read it. |

### Lane D: fairness without a model

Dividing a fixed budget across competing tenants is arithmetic, not judgment, so no model
is involved. The algorithm is deficit round robin (Shreedhar and Varghese, 1995), which
network routers use to stop one flow starving the others. It costs O(1) per item.

Every minute:

1. Group queued work by `(productId, campaignKey, kind)`, with a count and the oldest
   `dueAt`.
2. Serve priority 0 in full. Replies, clicks and imminent deadlines are never subject to
   fairness; they are the point.
3. For the rest, credit each `(product, campaign)` queue with a quantum, let it spend down
   to its backlog, and carry any unspent credit into the next round. A campaign of twelve
   people finishes quickly and hands its unused quantum back to the pool; a campaign of ten
   thousand cannot monopolise the lane.
4. Flip the selected items to `ready`, capped by the hour's remaining budget.
5. Record starvation: which campaign went unserved, for how many cycles, and how old its
   oldest item is.

That last step matters more than it looks. `sweep` used to read the first two hundred goal
instances in natural order and filter them afterwards, so a product whose first two hundred
rows were already planned reported "nothing to do" while thousands waited behind them. The
failure was silent. Under lane D a backlog is a number on a screen.

One subtlety worth recording, because it was wrong twice before it was right. A budget that
is not a whole multiple of quantum times campaigns always leaves a surplus, and somebody
takes it. Walking the queue list from the top each cycle gave that surplus to the same
campaigns every minute — fair inside a round and permanently unfair across an hour. Two
things fix it: the list is sorted so a rotation cursor means something, and a campaign the
budget never reached banks its quantum as deficit so it leads the next cycle. Verified over
two consecutive cycles rather than one, because one cycle cannot show it.

---

## Claude routines

Five main routines, each an orchestrator of its own sub-routines. A sub-routine is a
subagent spawned inside the main routine's session, not a separate schedule: the hourly
floor makes fifteen separate schedules impossible, and subagents give both parallelism
inside the hour and a fresh context window per unit of work. The main routine reads each
subagent's summary — twenty lines, not twenty thousand tokens — and logs one line of its
own.

### MAIN 1 — Acquire, hourly

Turns arrivals into people with a working sequence.

| Sub-routine | Role |
| --- | --- |
| 1.1 classify-batch | Runs N in parallel, a hundred people each. Input is a compact row — id, role, company, how they arrived, whether the address is a work address — not a full lead card. Output is one `classify` call carrying a hundred verdicts. The segment must come from the product's declared list. |
| 1.2 playbook-writer | Writes the sequence for a segment once, not per person: ordered steps with angles, gaps and the exploration quota. Runs about five times per product and then effectively never again. |
| 1.3 segment-auditor | Once a day. Finds near-duplicate segments — the audit found `smb_owner_other` and `other_smb_owner` living as separate buckets — and proposes a merge for a human to approve. |

### MAIN 2 — Advance, hourly

Keeps everyone mid-sequence supplied with a next message.

| Sub-routine | Role |
| --- | --- |
| 2.1 compose-tier1 | Writes the actual message, as blocks, for one person. Only tier 1 reaches it: hot, replied, or high fit. Everyone else is rendered by the engine from their playbook's template at no model cost. |
| 2.2 buffer-check | Looks for anyone with a live plan and an empty queue. This is the class of fault that killed ninety-two queued actions in the audit. |
| 2.3 cadence-fix | Where the plan says day twelve but the person went hot on day four, recomputes `dueAt` inside the band their temperature allows. |

### MAIN 3 — React, hourly

The smallest volume and the highest priority: people who did something.

| Sub-routine | Role |
| --- | --- |
| 3.1 reply-handler | Reads the reply and answers it from what the product can actually do. Never invents a capability to close someone. |
| 3.2 escalate-hot | Someone clicked and did not convert. The angle worked and the ask was wrong, so the remaining plan is rewritten, the next message written now, and its `dueAt` set in hours rather than days. |
| 3.3 objection-rewriter | Where the same objection has ended three people in one segment, the fix belongs in the playbook, not in one person's plan. |

The hourly floor means up to fifty-nine minutes between a click and a tailored reply. The
parts that genuinely cannot wait — stopping a sequence on reply, suppressing on
unsubscribe, moving the schedule when temperature changes — are lane B, and happen within
a minute. Only the writing waits.

### MAIN 4 — Close, hourly

Decides whether a person is done, dead, or still running.

| Sub-routine | Role |
| --- | --- |
| 4.1 verify-runner | Runs each campaign's checks and reads the raw probe responses rather than a summary of them. |
| 4.2 verdict-writer | Submits verdicts in batches. Success requires that every check actually passed; the tool refuses otherwise, and the correct response to a refusal is to repair the check. |
| 4.3 check-auditor | Once a day. A check that has passed for everyone it has ever run on is a constant, not evidence, and it ends campaigns for people who did nothing. |

### MAIN 5 — Maintain, daily

| Sub-routine | Role |
| --- | --- |
| 5.1 gaps-filler | Reads `setup_gaps` and finishes what setup left undone. |
| 5.2 template-drafter | Drafts missing ladder rungs in the brand voice. Always `draft`; this routine activates nothing. |
| 5.3 learner | Reads `what_works` across the product, retires angles that lost with enough sends to prove it, promotes those that won, and rewrites playbooks. An angle with few sends is untested, not losing. |

---

## Playbooks

The audit found 204 per-person plans collapsing into 49 distinct shapes, the largest used
26 times, produced by 204 separate model calls. Per-person planning at arrival is almost
entirely waste.

A playbook is a plan with no person attached: the ordered steps for a segment, written
once. At ingest the engine copies the playbook onto the new person's goal instance, so
everybody has a real sequence within seconds of arriving and before any model has looked
at them. Per-person planning survives only where it earns its cost — for people who
replied, clicked, or sit at the top of the fit range.

This inverts the current dependency. Today a person waits for Claude before they have a
plan. Under playbooks they get a plan immediately and Claude improves it later, which
matters because a generic but correct sequence sent today beats a perfect sequence written
on day sixteen.

Playbooks require segments to be a closed list. The product config declares two segments;
classification has invented twenty-two, most holding one to three people, which is too few
for `what_works` to learn anything from. `classify` should accept only the configured
segments plus `off_icp` and `unknown`, so adding a segment becomes a deliberate edit to the
config rather than an accident inside one classification.

---

## Tiers

Every person due for a touch falls into one of three tiers, and the tier decides who
writes the message.

| Tier | Who | Cost |
| --- | --- | --- |
| 1 | Hot, replied, or fit at or above 0.7 | One model call per touch, capped per day |
| 2 | Everyone else still running | Engine renders the playbook template. No model call. |
| 3 | Dead, budget spent, deadline passed | Nothing is sent. State is kept for whoever picks them up later. |

All three paths converge on the same renderer, the same brand kit, the same claims
validation and the same governor. A tier-2 message is not a lesser message; it is the same
machinery with deterministic copy.

---

## What guarantees nobody is missed

| Risk | Guard |
| --- | --- |
| A campaign is never selected | Lane D deficit round robin, plus a recorded starvation counter per campaign |
| Work is selected but the routine dies | Lease with expiry; lane G requeues it |
| An action is queued and never fires | Lane F alerts on anything more than two hours overdue |
| A routine fails to run at all | The queue is durable; the next run picks up everything, oldest first |
| A person arrives while Claude is behind | The playbook stamp gives them a sequence with no model in the path |
| The model plans past a limit | Budget, deadline, quiet hours, suppression and channel caps are enforced in `fireDue`, not in a prompt |
| Two runs work the same person | The action lease and the idempotency key on each touch |

---

## What was wrong

Found on 4 September 2026, and what each one is now.

| Fault | Was | Now |
| --- | --- | --- |
| Actions written by a session carried no `templateId`, and the send path treated that as a missing document | 71 messages failed; 92 queued would have failed the same way | `fireDue` resolves the ladder rung from how far through the sequence the person is (`resolveTemplateFor`) |
| `slotText` was not a field `resolveBlocks` read | Per-person copy was computed, stored and discarded; the template fallback shipped instead | `slotText` is part of `Precomposed` and survives repeated renders without duplicating the body |
| `setup_gaps` used the org id as the product id | Groom reported three gaps that did not exist and could not see the ones that did | Fixed; the tool reports against the real product |
| No `perHour` on the channel governor | Fifty sends rejected by the provider's hourly cap | `limitsFor` assumes 90/hour where a channel declares nothing |
| `cadenceByTemp` was advisory only, and inverted | A person who clicked waited longer than one who ignored five emails | `cadence.ts` enforces it, with hot tightened to 0.25–1 day and cold widened to 3–5 |
| A signal could not move a queued action's date | Temperature changed a number and nothing else | The signal lane recomputes `dueAt` on band change and queues an escalation |
| `sweep` filtered after limiting | Silently reported no work while thousands waited | Queries the condition, sorted oldest first |
| Routine prompts hardcoded one product id | Schedules multiplied with products | Five org-scoped mains, each orchestrating its own sub-routines |
| Nothing noticed a message that was due and never sent | 71 died unseen for a day | The watchdog lane raises a notification past two hours |
| A killed session took its batch with it | Work lost silently | Leases are reaped and requeued every minute |
| One sending channel | Roughly a hundred an hour, against a need of thousands a day | Unchanged. See below. |

---

## Sending capacity

This is the constraint no code change relieves. Ten thousand people at nine touches is
ninety thousand messages; over thirty days that is three thousand a day. Industry practice
for cold outbound puts the realistic ceiling near fifty per inbox per day before
deliverability degrades, which implies roughly sixty warmed inboxes, or a sending provider
on a dedicated warmed subdomain. The `channels` collection already holds several channels
per product and `pickChannelFrom` already selects one per person; what is missing is a
per-inbox governor, a warmup ramp and rotation. Until that exists, campaign size should be
set from the capacity that actually exists rather than from the size of the spreadsheet.

---

## Verifying it

`npm run verify:orchestration` runs twelve checks against the live database and writes
nothing. Every case is one that actually went wrong rather than one invented to exercise a
branch: the template that could not be resolved, the copy that was written and discarded,
the re-render that duplicated a body, the click that moved nothing, the small campaign that
waited behind nine large ones, the surplus that always went to the same queue.

`npm run repair:dead` returns messages that failed for reasons that no longer exist. It is a
dry run unless given `--commit`, and it declines anything whose cause is still real: a
person who has since unsubscribed or replied, a campaign that has closed, a step that has
since been written again.

## Still open

Sending capacity, and only that. Ten thousand people at nine touches is ninety thousand
messages, three thousand a day over a month, against a realistic ceiling near fifty per
inbox per day for cold outbound. The code paths are ready for it — `channels` holds several
per product and `pickChannelFrom` already selects one per person — but the inboxes, the
warmup ramp and the rotation do not exist yet. Until they do, campaign size should be set
from the capacity that exists rather than from the size of the spreadsheet.
