import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { nextCronRun, parseCron } from "./cron.js";
import { notify } from "./notify.js";
import { ROUTINE_KEYS, type RoutineKey } from "./runlog.js";

/**
 * What a routine is, and whether the one that should be running actually is.
 *
 * The schedule itself lives in Claude, not here — we cannot read it, and a copy typed into
 * this app would rot the first time someone edited the real one. So the routine reports its
 * own cron on every run through `register_routine`, and the copy stays true by being
 * rewritten constantly. When the copy and reality disagree, the lateness check below is
 * what notices.
 */

export interface RoutineDef {
  key: RoutineKey;
  name: string;
  cron: string;
  human: string;
  job: string;
  /** One line each. A paragraph describing three cases reads as none of them. */
  example: string[];
  prompt: string;
  essential: boolean;
}
/**
 * One run per hour is the floor the scheduler enforces, and runs are staggered by a few
 * minutes on top of that. Both facts shape everything below.
 *
 * Nothing time-critical may sit in one of these routines, because an hour is too long to
 * wait to stop a sequence for somebody who replied. That work is the engine's, on the
 * minute clock. And no routine may assume another has just finished, because the stagger
 * means it may not have: the only handoff between them is the queue.
 *
 * The minutes spread them so five sessions do not open on the same database at the same
 * second. Maintain is daily because setup gaps are a day-scale problem — hourly would mean
 * twenty-four notifications about the same missing lead source.
 */
export const DEFAULT_CRONS: Record<RoutineKey, string> = {
  acquire: "0 * * * *",
  advance: "15 * * * *",
  react: "30 * * * *",
  close: "45 * * * *",
  maintain: "50 7 * * *",
};

/**
 * The five main routines, prompt and all.
 *
 * Each one is an orchestrator of its own sub-routines rather than a single pass of work.
 * The reason is arithmetic: a session's context is what bounds how many people it can get
 * through, and reading a person costs roughly the same whether the session then does one
 * thing with them or ten. Spawning a sub-agent per slice of work gives each slice a fresh
 * window and returns twenty lines to the main routine instead of twenty thousand tokens, so
 * the main routine's own context stays flat whether the org holds a thousand people or a
 * hundred thousand. This is the documented failure of orchestrator patterns — the
 * orchestrator accumulating every worker's context until it overflows — and it is avoided
 * here by making the handoff a database row rather than a conversation.
 *
 * They are scoped to the org, not the product. A routine per product meant forty scheduled
 * sessions for ten products, and each of them chose its own work by sweeping in disk order.
 * Now the engine decides what is ready and whose turn it is, every minute, and a routine
 * asks only for its slice.
 */
export function routineCatalog(productId?: string): RoutineDef[] {
  const scope = productId
    ? `You are scoped to product ${productId}. Pass product_id "${productId}" wherever a tool accepts one.`
    : `You work across every product this token owns. Do not pass product_id unless you are deliberately narrowing to one — the engine has already balanced the work across products and campaigns, and narrowing undoes that.`;

  const registration = (key: RoutineKey) =>
    `Start by calling register_routine with routine "${key}" and the cron you scheduled this
session on${productId ? `, and product_id "${productId}"` : ""}. It is what lets the console show when you last ran and
when you are due next. If you are late, that is how anyone finds out.`;

  const contract = `How work reaches you:

- next_work("<kind>") gives you your slice. The engine has already decided what is
  ready and divided it fairly across every product and campaign, so you do not
  choose what to work on and you must not go looking for more. Urgent items —
  someone who replied or clicked — come first automatically.
- finish_work(job_ids) hands back what you completed. Anything you do not finish
  returns to the pool on its own when the lease expires, so if you run low on room,
  stop. Never report work you did not do; the queue is what remembers, not you.
- If next_work returns nothing, say so in one line and stop. An empty slice with a
  non-zero still_waiting means the dispatcher has more coming next round, not that
  you should go and find it yourself.
- Before you finish, call backlog_report and say what is still waiting. A backlog
  nobody reports is a backlog nobody fixes — this system once hid nine thousand
  unplanned people behind a routine that cheerfully said "nothing to do".

How to use your sub-routines:

Each numbered step below is a sub-routine. Run it as its own sub-agent, in parallel
where the steps are independent, and give each one only the slice it needs. Ask each
to return a short summary — counts, and anything a person would want to know — never
its full working. Your own job is to split the work, read the summaries and write one
line of run notes. Do not do the per-person work yourself: your context is the thing
that runs out, and once it does the rest of the hour's work is lost.`;

  return [
    {
      key: "acquire",
      name: "1 — Acquire",
      cron: DEFAULT_CRONS.acquire,
      human: "every hour, on the hour",
      essential: true,
      job: "Turn arrivals into people with a working sequence: read who they are, and make sure their segment has a playbook to run.",
      example: [
        "Eight hundred leads arrive overnight; one call reads a hundred of them and eight of those run at once.",
        "Anand reads as an engineering leader, so the engine swaps him onto that segment's playbook before his second message.",
        "A segment with no playbook gets one written — once, for everybody in it, instead of once per person.",
      ],
      prompt: `${scope}

${registration("acquire")}

${contract}

Your job is who these people are, and what sequence they run. It is not what any
individual message says. In most campaigns it is not one person's plan either — they
run their segment's playbook until they do something. The exception is a campaign
that plans each lead (1.3): there every lead gets a plan of their own as soon as they
have been read.

1.1 classify-batch
  next_work("classify") with limit 100. Split what comes back across parallel
  sub-agents, about a hundred people each, and have each one submit its whole
  batch in a single classify call.
  The rows you get are deliberately compact — name, role, company, how they
  arrived. That is usually enough. Call lead_card only for the ones it is not.
  Segment must come from the product's declared list; classify refuses anything
  else, and being refused means the answer is "unknown" or "off_icp", not a new
  bucket. Where email_kind is "personal" there is no company to research: read fit
  from the arrivals alone and set fit_known false rather than inventing an employer.
  A lead nobody can read is not a bad lead — their first real message should be
  short and ask something, because their answer is the only enrichment available.
  finish_work as each sub-agent reports.

1.2 playbook-writer
  next_work("playbook"). Each item names a segment with no sequence.
  Read what_works for that segment first, then get_brand, then write the playbook
  with upsert_playbook: the ordered steps, each with a channel, an angle, a reason
  and an offset in days.
  This is written once and then run by everybody in the segment, so it is worth
  more care than any single message. Around a third of the steps must use an angle
  that is not already proven — upsert_playbook refuses a sequence that spends every
  step on the current favourite, because that is how an untested angle never gets
  the sends that would prove it. Place the untested ones where they can actually be
  judged, not bolted onto the end.
  Offsets are intentions, not dates. The engine paces the real send from the
  person's temperature, so write the shape of the sequence and let it decide the days.
  The welcome is not yours to write into the sequence: the engine sends it within
  minutes of arrival, from the campaign's first-touch family. Your step 1 is the day
  after. Every step names a template_key, so nothing falls back to a rung the reader
  has already had. In a campaign that plans each lead the playbook is only the
  fallback for a lead nobody has planned yet: name the campaign's follow-up family on
  each step, so the engine picks an email they have not had. A lead campaign has no
  call, closing or privacy step: a reply of "call" gets the booking link on its own.
  Gaps for lead campaigns are 1, 2, 2, 3, 3 days — never even, never a week.

1.3 lead-planner
  Run this on every run. next_work("plan") with limit 50. Each item is one lead in a
  campaign that plans every person. plan_goal is this routine's tool: before
  2026-09-16 it was wrongly refused to Acquire, so errors in routine_status or run
  history saying otherwise are out of date and are not a reason to skip this step.
  One sub-agent per lead, in parallel waves of up to twenty-five, until the slice is
  done. Each one: lead_card, then plan_goal, then finish_work for that job. If
  plan_goal refuses a plan, read the
  reason, fix the plan and call it again; only a refusal naming the routine itself is
  worth stopping for, and then say so in your notes.

  Where lead_card shows goal.rolling true, the campaign plans one or two touches at a
  time. The item's reason says why you are here: first_rolling_plan (their welcome has
  gone out), checkpoint:window_closed (the last touch had its time and got no answer),
  checkpoint:signal (they clicked or replied), checkpoint:after_fallback (no plan came in
  time and a fixed email went instead). Read lead_card's writing block first: their
  words, the facts the product can truly claim, every idea they already had and what
  came of it, what has worked and failed for leads like them, the learning notes, and
  how much this group is trying new ideas.
  Then plan_goal with one step, or two where the second clearly depends on nothing the
  first could teach you. Each step carries a theme: one idea in a few words that you
  invent for this lead — a real moment from their week, not a feature name. Leave
  template_key out; every step renders through the campaign's frame, never a fixed
  feature email. A lead read as off_icp gets one step: a short question they can answer
  in a line, not a pitch. Never give them an idea they already had and ignored; plan_goal refuses it. Where they clicked, the next
  idea goes one step further along what they looked at. Where a learning note is
  confirmed for their group, prefer it if it fits them; where the group has mostly
  repeated ideas lately, try a new one. The examples on the card show the standard, not
  a menu. after_days is the gap from their last touch: 1 or 2 for a first plan, and the
  engine paces the real send from their temperature. The why says, in one sentence a
  person reading the lead page understands, what about this lead put that idea there.

  Where goal.rolling is false:
  Their welcome has gone out and they are still on the standard steps, which the
  engine holds back for up to twelve hours waiting for this plan.
  lead_card's goal.plan_from lists the emails this campaign may send: what each says,
  whether this lead already had it, and how it has done so far. Choose the ones that
  fit this lead and order them for this lead: the feature closest to their situation
  first — read enrichment.siteText, their role, team size, segment and how they
  arrived — and setup last. Leave out what does not fit; four right emails beat seven.
  Every step names one template_key from that list, never the family, with a why a
  person reading the lead page understands in one sentence: what about this lead put
  that email in that place. Gaps 1, 2, 2, 3, 3 days; the engine paces the real send
  from their temperature. The rationale is two sentences: who they are, and what the
  plan leads with.
  Where two emails fit equally, prefer the one the results favour; an email with few
  sends is untested, not losing. plan_goal skips the standard step that was waiting,
  so do not look for it.

1.4 segment-auditor
  On your first run of the day only. Call report and look at the segment spread.
  Where two segments are plainly the same bucket under different names, say so in
  your run notes and name the merge you would make. Do not merge anything yourself:
  people are already running those playbooks, and a rename that lands mid-sequence
  changes what a person receives without anyone having asked for it.

1.5 asset-describer
  next_work("groom"). Items whose reason is describe_asset name an asset a person
  added with only a name and a file; nothing can offer it until it is described.
  One sub-agent per asset, up to five. Each one: view_asset, which shows the file
  itself beside the product's segments, then describe_asset, then finish_work.
    use_when   the reader and the moment it suits, in plain words, naming segments
               from the product's list;
    proves     the one thing a reader believes afterwards that they did not before;
    one_line   the sentence that introduces it in an email. It is printed to the
               reader as the picture's alt text or the link's words, so it follows
               the product voice: professional, full sentences, no names.
  Describe what the file actually shows, never what the product page says it could.
  If it shows a real person's name, private data, or an incident such as a security
  failure, set looks_unsafe and say what in note: the asset goes back to draft for a
  person to replace, which is cheaper than a prospect reading it. Leave any other
  groom item alone.`,
    },
    {
      key: "advance",
      name: "2 — Advance",
      cron: DEFAULT_CRONS.advance,
      human: "every hour, at :15",
      essential: true,
      job: "Write the messages for the people worth writing for. Everyone else is already being served by the engine from their playbook.",
      example: [
        "Rahul fits at 0.85 and his next step is due Thursday: subject, around 140 words, a link, an opt-out.",
        "His step after that is WhatsApp — about 45 words, no link — so the same angle becomes different writing.",
        "Four thousand colder leads get the same step rendered from the template, and cost nothing.",
      ],
      prompt: `${scope}

${registration("advance")}

${contract}

Only people who have earned a written message reach you: someone hot, someone who
replied, or a strong fit early in their sequence. Everyone else already had their
next message rendered by the engine from their playbook's template, with their name
and their segment's pain merged in. That is not a lesser message — it goes through
the same brand kit, the same claims validation and the same send guardrails — it
simply does not need you.
The exception is a campaign marked composeAll: there, every step after the welcome
comes to you, because every person in it chose to click an ad. For those, lead_card
carries enrichment.siteText — what their company says it does — and enrichment.form,
the answers they typed. Never how they arrived ("you clicked", "you asked"), never an
earlier mail from us, never their company's name, never any person's name. First
person plural; the frame or template signs off, so you never do.

A rolling campaign (lead_card goal.rolling true) is where the writing matters most.
The step names an idea (its theme) and renders through a frame that adds only the
greeting, the button, the sign-off and the unsubscribe line. Write it in parts, not
one block of text, because a wall of paragraphs is skimmed and ignored:
  subject    required; see below.
  preheader  under 90 characters, adds to the subject (shown in letter and html only).
  opening    one sentence under 90 characters, the idea's sharpest line in their world.
             Bold in HTML; in plain text it is the inbox preview beside the subject, so
             it adds to the subject and never repeats it.
  scene      one or two short paragraphs that make the idea a scene they recognise
             from their own week. At most two **bold** phrases, on the words that
             carry the cost or the pain.
  cost_lines up to three lines: label is the situation with its numbers, under 40
             characters ("₹4 lakh order × 5 days waiting"); value is the result, under
             50 ("5 days a farmer loses before sowing"). A number that is not a fact is
             an example; cost_intro defaults to "For example:".
  shows      up to three lines under 50 characters on what they would see, only what
             writing.facts supports and nothing from facts.unverified.
  limit      one line on what is not recorded, only where the fit is partial.
  question   one line they can answer. Bold in HTML.
  ps         optional, one line, no link.
  timeline / reply_options
             two layouts on test. lead_card writing.layout_tests gives this lead's arm
             for each, fixed for good; follow it. Timeline (story ideas only): 2 to 4
             moments, {when: "Monday", what: "the drawing waits for approval."}.
             Reply options (reply asks only): 2 to 4 short answers to the question,
             shown as "Reply with one number:" and "1 = ..." lines.
             In HTML the cost lines become a tinted box and shows a check list; in
             plain text each cost line is the situation with "→ result" under it, and
             shows are dash lines. Open on their world (their main problem, what the
             company does, team size). The examples on the card show the standard;
             write better than them for this person.
  Plain-text rules, from what respected senders do: quantities as digits ("5 days",
  "9 hours", "3 of 9 hours"), the whole body within 125 words including lists, and
  only these symbols: → – × ÷ = ₹ • ✓ (never ✔ ☑ ➡ ▶ ⚠ ™, styled letters or emoji).
  Simple and clear, because a busy owner reads it once: say what the product is in
  one plain line (writing.product_in_one_line), usually as shows_intro, for example
  "TeamGrid shows how your office team spends its day on the computer. You would
  see:". Short sentences, one idea each, never over 20 words. Everyday words, no
  wordplay or metaphor; name the problem the way they would say it ("orders wait
  for approval"), and use the plain word from writing.plain_words ("approval", not
  "sign-off"; "stuck", not "blocked").
  format     "text": a plain note that asks for a reply and carries no link; the
             default for early touches and anyone who has not clicked. "letter": HTML
             that looks typed, bold phrases and a link on its own words, no logo, box
             or button; for a link ask or where a bold phrase carries the idea. "html":
             the branded design, for a sample, table or screen, or a lead who engages
             with designed mail. format_why says which, in one sentence.
  theme      the plan step's idea, reworded only if your writing sharpened it.
  hook       story, rupee_math, question, comparison, proof, or your own word.
Write about their situation as a fact of their business, never as something they told
us: no "you named", "you mentioned", "your form"; compose_batch refuses those.
Before you submit, write three different opening lines and keep the one a busy founder
would stop scrolling for. Professional register: complete sentences, no contractions.
compose_batch refuses a missing format, a subject word the product avoids, their
company's name, a body over the limit, quantities spelled out, lines over their length,
an opening that repeats the subject, plain text with a link ask, and a layout that
ignores the lead's test arm; it warns about numbers that read as facts: fix a warning
rather than submitting past it.
A step not written within six hours goes out as a fixed email they have not had.

In a campaign that plans each lead but is not rolling, each step names the email for
one feature; your words open on their situation and lead into that feature, and the
template's fixed text shows it. Never repeat what the fixed text says. A step not
written within six hours goes out with the template's own opening line instead.

The ask ladder. Every mail asks for one thing, and by default that thing is the trial
link, because the campaign is won by a signup and nothing else. Pass ask "link" and the
template's button is the whole ask.
One mail in a sequence asks for a reply instead: the touch that follows a mail they
neither opened nor clicked. The link has already been ignored once there, and a
question they can answer in ten seconds is the cheaper thing to ask for; their answer
also tells the next mail what to lead with. Pass ask "reply", end the body on a
question answerable in one line, and the button is left off the rendered mail.
After any click or reply, every later mail is a link ask again. Never both asks in one
message; compose_batch refuses a reply ask that does not end on a question, and the
engine refuses one that carries a link.

The subject. Twenty to sixty characters, carrying a number, their own metric or a
question — "TeamGrid on 11 people, week one", not "Welcome to TeamGrid" and not the
name of a feature. The product name may lead the subject where it earns the open, on a
first touch or a price mail; it is not a substitute for a reason to open. Never open a
subject with "welcome" to somebody who has not signed up, and never put their first
name in it on its own.

2.1 compose-tier1
  next_work("compose") with limit 50. One sub-agent per person, in parallel waves of
  up to twenty-five, until the slice is done.
  Each one: lead_card for context, then compose_batch for the step it names.
  Write to the channel's shape. lead_card lists each channel's real limits: an email
  carries a subject, a few hundred words, a link and an opt-out; a WhatsApp message
  is a couple of sentences with no link, and outside its reply window it must use an
  approved template. The same angle becomes two different pieces of writing.
  Read their prior touches. Never repeat a claim already made to them, never
  contradict one, and let the register escalate naturally across a sequence.
  The lower your confidence in someone, the harder the opening line has to work: be
  specific and a little cheeky rather than polite and generic, because a message that
  reads like every other message gets deleted unread. This never licenses a false
  claim — no invented capability, no number the product cannot back.

2.2 buffer-check
  Call backlog_report. If the compose queue is empty but people are still in flight,
  that is worth a line in your notes: it usually means the engine is serving them
  from their playbook, which is correct, but it is also what a silent breakage looks
  like. Say which of the two you think it is.

2.3 template-gap
  Where a person's step needed a template rung the product does not have, say so
  rather than working around it. Maintain drafts the missing rung tonight; writing a
  one-off message that papers over it means the gap is never found.`,
    },
    {
      key: "react",
      name: "3 — React",
      cron: DEFAULT_CRONS.react,
      human: "every hour, at :30",
      essential: true,
      job: "The people who did something. Smallest volume, highest value, and the only routine that rewrites one person's plan.",
      example: [
        "Dhaval clicked the report link and did not sign up: the angle worked and the ask was wrong, so his next message asks something smaller.",
        "Deepa replied \"ask in Q3\" — campaign closed, cooling until July, her reason kept for whoever picks her up then.",
        "The surveillance objection has now ended three agency owners, so the fix goes in the playbook, not in one person's plan.",
      ],
      prompt: `${scope}

${registration("react")}

${contract}

Everything here is urgent by construction: the engine only queues an escalation when
somebody clicked, replied, or went hot. The parts that could not wait for you have
already happened — a reply stopped their sequence within the minute, an unsubscribe
suppressed them, a temperature change moved their next message's date. What is left
is the judgment, and that is yours.

3.1 reply-handler
  next_work("escalate") and take the items whose reason is a reply.
  One sub-agent per person: read what they actually wrote, then record_reply with a
  grounded answer. The answer is the message itself — it is queued into their thread
  as plain text and held in Review for a human to release, so write what you would
  send them, not a summary of what should be said. Never invent a capability to close
  someone; leave the answer out rather than guessing at one. A reply that says "not
  now" is a date, not a rejection — record the reason so whoever picks them up later
  knows what was said.

3.2 escalate-hot
  The rest of the escalate items: people who clicked and did not convert.
  One sub-agent per person. Read what_works once for the run, then their lead_card —
  it carries angles_tried, every angle already spent on them and whether they
  clicked. plan_goal refuses an angle they were sent and ignored, so read it first
  rather than being refused. An angle they clicked is not spent: it reached them and
  the ask was wrong, so keep the angle and make the ask smaller.
  Then plan_goal for the steps that remain, and compose_batch for the next one. Do
  not spread the remaining budget evenly: they are paying attention now and will not
  be next week, so weight it towards the front. Someone who clicked is hours from
  deciding, not days: the next message goes out inside the hot band (hours).
  In a rolling campaign (goal.rolling true) plan only the next one or two touches, as
  the lead planner does: each step a new theme that takes what they clicked or wrote one
  step further, the first one due within hours. Read lead_card's writing block first.
  In a campaign that plans each lead but is not rolling, the new plan is built from lead_card's
  goal.plan_from like the first one, and starts from what they clicked: the email
  that takes the next step from that feature (usually setup), then the one or two
  closest to it. Say in the rationale what they did that changed the plan — the lead
  page shows it. No call step: a reply of "call" gets the booking link on its own.
  Their step 1 opens on what they looked at, not on what they clicked in our mail.

3.3 objection-rewriter
  When you have seen the same objection end three or more people in one segment,
  that is not a person-level problem. Say so, and fix the segment's playbook with
  upsert_playbook so everybody still running it gets the better sequence. One
  playbook edit is worth more than thirty rescued individuals.`,
    },
    {
      key: "close",
      name: "4 — Close",
      cron: DEFAULT_CRONS.close,
      human: "every hour, at :45",
      essential: true,
      job: "Decide who is done, who is finished with, and who is still running — and keep the checks that decide it honest.",
      example: [
        "Priya's probes show an account and two sessions, so she is marked succeeded and her queued messages are cancelled.",
        "A check that has passed for every single person it ever ran on is not evidence; it is a constant, and it has been ending campaigns for people who did nothing.",
        "Rahul has spent his budget with no reply — a real ending, recorded as one.",
      ],
      prompt: `${scope}

${registration("close")}

${contract}

4.1 verify-runner
  next_work("monitor") with limit 50. Split across sub-agents.
  For each person read last_probes — what the tools actually returned — alongside
  check_results and their last message. Where a check is undetermined, call
  verify_person, read the raw response, and resolve_check only if it plainly
  supports the verdict.

4.2 verdict-writer
  Decide, and submit them together with mark_state:
    succeeded  the evidence plainly shows it. Not "probably".
    failed     a real ending: they said no, or the budget and deadline are spent.
               Never because a check has simply not passed yet.
    continue   still running. Say in one line where they are.
  mark_state refuses "succeeded" unless every check the campaign defines has
  actually passed. If it refuses, the answer is to repair the check — never to route
  around it.

4.3 check-auditor
  On your first run of the day, look at both verification lists.
  verification_looks_wrong is two weeks with nothing passing — usually a check bound
  to the wrong tool.
  verification_too_easy is the more dangerous one: a check that has passed for
  everybody it has ever run on. That is not evidence, it is a constant, and it ends
  campaigns for people who have done nothing. Read one probe and compare the scope
  the args asked for against the scope the response says it used — a provider that
  ignores an argument it does not have the privilege for will answer about your own
  account instead. Repair both with verifiers and set_checks.`,
    },
    {
      key: "maintain",
      name: "5 — Maintain",
      cron: DEFAULT_CRONS.maintain,
      human: "once a day, 07:50",
      essential: false,
      job: "Finish what setup left half-done, learn from what has actually worked, and ask for the rest exactly once.",
      example: [
        "A product with a welcome and nothing after it gets its day-three nudge and last call written in its brand voice, left as drafts.",
        "The margin-leak angle has forty sends and no clicks, so it is retired from the playbooks that still use it.",
        "Four campaigns have sat unstarted for six days — one notification says so, naming the lead source they are all waiting on.",
      ],
      prompt: `${scope}

${registration("maintain")}

${contract}

This runs once a day. It finishes setup nobody came back to, learns from what has
actually happened, and asks for what only a person can give — once, not daily.

5.1 gaps-filler
  setup_gaps for each product. If gaps is empty, say "setup is complete" and move on.
  Fill what you can: missing ladder rungs get get_brand first so the copy suits the
  design, then upsert_template, always status "draft", checked with preview_template
  before you move on. A campaign with no verification plan gets verifiers then
  set_checks.
  Everything you write stays a draft. This routine never activates anything — a
  campaign that starts sending because a scheduled session decided it was ready is
  the worst possible surprise.

5.2 playbook-learner
  what_works for each product. Read it carefully: a rate over trackable sends is
  evidence, a null rate means those messages could never report and prove nothing
  either way, and an angle marked "untested" has too few sends to have failed — it
  has not been tried. Retiring one of those is how a product locks onto whatever won
  first and stops learning.
  Where an angle has genuinely lost with enough sends to say so, rewrite the
  playbooks that still use it. Where one has genuinely won, give it more of the
  sequence — but never all of it; upsert_playbook refuses a sequence with no
  untested angle in it, for the same reason.

5.3 learning-analyst
  what_works for each product, reading themes and learning_notes. The themes table is
  every written touch from a rolling campaign, by lead group, idea, hook, format, ask
  and channel. For each group with enough written touches to say anything:
    - what is working: an idea, hook, format or ask with responses where others in the
      same group have none;
    - what is not: ideas with ten or more sends and no click or reply;
    - differences between groups: the same idea landing with small teams and not large.
  Write each finding with save_learning, one stable key per finding, rewriting it as
  its evidence grows. Status follows the evidence and nothing else: guess under five
  sends, promising with a response, confirmed at ten or more sends with two responses,
  retired at ten or more with none. Never confirm on less; one lucky reply confirmed is
  how every lead ends up getting the same opening. Say in your notes which ideas you
  retired and which you confirmed today.

5.4 owner-asks
  For what only a person can supply — a lead source, a send channel, a real trial
  link, a brand nobody has confirmed, a sending capacity too small for the campaign
  size — call notify_owner once, with all of it in one message. It is deduped for
  seven days, so repeating yourself costs you nothing and gains them nothing.
  Then say plainly what you drafted and what you are waiting on.`,
    },
  ];
}

export interface RegisterInput {
  orgId: string;
  productId: string;
  key: RoutineKey;
  cron: string;
  note?: string;
}

export interface RegisteredRoutine {
  key: RoutineKey;
  cron: string;
  note?: string;
  enabled: boolean;
  registeredAt: Date;
  lastSeenAt: Date;
}

/**
 * A routine declaring itself and its schedule. Idempotent, and re-asserted on every run, so
 * editing the cron in Claude corrects our copy on the next firing without anyone touching
 * this app.
 */
export async function registerRoutine(input: RegisterInput): Promise<{ cron: string; nextRunAt: Date | null }> {
  if (!parseCron(input.cron)) throw new Error(`"${input.cron}" is not a five-field cron expression`);

  const db = await getDb();
  const now = new Date();
  await db.collection(C.routines).updateOne(
    { orgId: input.orgId, productId: input.productId, key: input.key },
    {
      $set: { cron: input.cron, note: input.note ?? null, enabled: true, lastSeenAt: now },
      $setOnInsert: {
        orgId: input.orgId,
        productId: input.productId,
        key: input.key,
        registeredAt: now,
      },
    },
    { upsert: true },
  );

  return { cron: input.cron, nextRunAt: nextCronRun(input.cron, now) };
}

export async function listRegistered(orgId: string, productId: string): Promise<RegisteredRoutine[]> {
  const db = await getDb();
  const rows = await db.collection(C.routines).find({ orgId, productId }).toArray();
  return rows
    .filter((r) => (ROUTINE_KEYS as readonly string[]).includes(String(r.key)))
    .map((r) => ({
      key: String(r.key) as RoutineKey,
      cron: String(r.cron),
      note: r.note ? String(r.note) : undefined,
      enabled: r.enabled !== false,
      registeredAt: new Date(String(r.registeredAt)),
      lastSeenAt: new Date(String(r.lastSeenAt ?? r.registeredAt)),
    }));
}

export async function setRoutineEnabled(
  orgId: string,
  productId: string,
  key: RoutineKey,
  enabled: boolean,
): Promise<void> {
  const db = await getDb();
  await db
    .collection(C.routines)
    .updateOne({ orgId, productId, key }, { $set: { enabled } });
}

export type RoutineHealthState = "ok" | "late" | "never" | "unregistered" | "paused";

export interface RoutineHealth {
  key: RoutineKey;
  name: string;
  registered: boolean;
  enabled: boolean;
  cron: string;
  /** True when the cron we hold came from the routine itself rather than from our default. */
  cronFromRoutine: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  nextRunAt: Date | null;
  /** How overdue, in minutes. Zero when it is not. */
  lateByMinutes: number;
  state: RoutineHealthState;
}

/** A routine is not late the instant it is due — a scheduler is allowed to be a bit slow. */
const GRACE_MS = 20 * 60_000;
/** How long before an unfixed lateness alert says so again. */
const RENOTIFY_MS = 60 * 60_000;

export async function routineHealth(orgId: string, productId: string): Promise<RoutineHealth[]> {
  const db = await getDb();
  const now = new Date();
  const registered = new Map((await listRegistered(orgId, productId)).map((r) => [r.key, r]));

  const lastRuns = await db
    .collection(C.routineRuns)
    .aggregate([
      { $match: { orgId, productId, routine: { $in: [...ROUTINE_KEYS] } } },
      { $sort: { startedAt: -1 } },
      { $group: { _id: "$routine", startedAt: { $first: "$startedAt" }, status: { $first: "$status" } } },
    ])
    .toArray();
  const lastByKey = new Map(lastRuns.map((r) => [String(r._id), r]));

  return routineCatalog(productId).map((def) => {
    const reg = registered.get(def.key);
    const last = lastByKey.get(def.key);
    const lastRunAt = last ? new Date(String(last.startedAt)) : null;
    const cron = reg?.cron ?? def.cron;
    const nextRunAt = nextCronRun(cron, lastRunAt && lastRunAt > now ? lastRunAt : now);

    let state: RoutineHealthState = "ok";
    let lateByMinutes = 0;

    if (!reg) {
      state = "unregistered";
    } else if (!reg.enabled) {
      state = "paused";
    } else if (!lastRunAt) {
      // Registered but never seen running. Only a problem once a firing has been missed.
      const dueBy = nextCronRun(cron, reg.registeredAt);
      if (dueBy && now.getTime() > dueBy.getTime() + GRACE_MS) {
        state = "never";
        lateByMinutes = Math.round((now.getTime() - dueBy.getTime()) / 60_000);
      }
    } else {
      const expected = nextCronRun(cron, lastRunAt);
      if (expected && now.getTime() > expected.getTime() + GRACE_MS) {
        state = "late";
        lateByMinutes = Math.round((now.getTime() - expected.getTime()) / 60_000);
      }
    }

    return {
      key: def.key,
      name: def.name,
      registered: Boolean(reg),
      enabled: reg?.enabled ?? false,
      cron,
      cronFromRoutine: Boolean(reg),
      lastRunAt,
      lastStatus: last ? String(last.status) : null,
      nextRunAt,
      lateByMinutes,
      state,
    };
  });
}

function describeLate(minutes: number): string {
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/**
 * Raises the bell for a routine that has stopped.
 *
 * This is the part of run logging that earns its keep. A log page nobody opens does not
 * catch a Monitor routine that quietly stopped firing six hours ago; a notification does,
 * and until it fires nobody is ever marked as finished.
 */
export async function checkRoutineHealth(orgId: string, productId: string): Promise<void> {
  const db = await getDb();
  const base = `/products/${productId}`;
  const now = new Date();

  for (const health of await routineHealth(orgId, productId)) {
    const dedupeKey = `routine:${health.key}:late`;

    // Nothing to say about a routine that was never set up, or one deliberately paused.
    if (health.state === "unregistered" || health.state === "paused" || health.state === "ok") {
      // A routine that started firing again clears its own alarm.
      if (health.state === "ok") {
        await db
          .collection(C.notifications)
          .updateMany({ orgId, productId, dedupeKey, readAt: null }, { $set: { readAt: now } });
      }
      continue;
    }

    // This runs on the tick, once a minute. Without a throttle the bell would show
    // "Monitor is late" with a count of four hundred by lunchtime.
    const existing = await db
      .collection(C.notifications)
      .findOne({ orgId, productId, dedupeKey, readAt: null });
    if (existing && now.getTime() - new Date(String(existing.updatedAt)).getTime() < RENOTIFY_MS) continue;

    const late = describeLate(health.lateByMinutes);
    await notify({
      orgId,
      productId,
      severity: "critical",
      dedupeKey,
      title:
        health.state === "never"
          ? `The ${health.name} routine has never run`
          : `The ${health.name} routine is ${late} late`,
      body:
        health.state === "never"
          ? `It is scheduled as ${health.cron} but has not called in once. Check the schedule in Claude still has the connector attached.`
          : `Last run ${health.lastRunAt?.toISOString().slice(0, 16).replace("T", " ")} UTC. Scheduled ${health.cron}.`,
      href: `${base}/logs`,
    });
  }
}
