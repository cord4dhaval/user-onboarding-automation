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
 *
 * Every run costs tokens even when it finds nothing, so only Acquire and Advance run round
 * the clock: a lead who arrives at night is planned before morning, and a step Advance has
 * not written within six hours goes out as a fixed email. React, close and linkedin run
 * every second hour in Indian working hours, 10:00–21:15 IST (2026-09-23: about a hundred
 * empty runs a day were a large share of the plan). Crons are UTC.
 */
export const DEFAULT_CRONS: Record<RoutineKey, string> = {
  acquire: "34 * * * *",
  advance: "15 * * * *",
  react: "30 4-14/2 * * *",
  close: "45 5-15/2 * * *",
  maintain: "50 7 * * *",
  linkedin: "40 4-14/2 * * *",
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
    `Start by calling register_routine with routine "${key}", cron "${DEFAULT_CRONS[key]}"${productId ? ` and product_id "${productId}"` : ""},
in the same turn as your first next_work. The cron is given here so you never have to look
it up. It is what lets the console show when you last ran and when you are due next.`;

  const contract = `How work reaches you:

- next_work("<kind>") gives you your slice. The engine has already decided what is
  ready and divided it fairly across every product and campaign, so you do not
  choose what to work on and you must not go looking for more. Urgent items —
  someone who replied or clicked — come first automatically.
- finish_work(job_ids) hands back what you completed. Anything you do not finish
  returns to the pool on its own when the lease expires, so if you run low on room,
  stop. Never report work you did not do; the queue is what remembers, not you.
- A refusal names one problem at a time. Fix it and send again: a new reason means
  the work is getting closer, so keep going. Leave the item and move on only when the
  same reason comes back after you fixed it, or after five refusals on one item.
  Looping on the same refusal spends the run on one item while the rest wait.
- If every next_work returns nothing, say so in one line and stop. Call no other tool:
  not backlog_report, not routine_status, nothing to check health. An empty run should
  cost two calls. An empty slice with a non-zero still_waiting means the dispatcher has
  more coming next round, not that you should go and find it yourself. The one exception
  is a step below that reads something other than the queue: run those first, and stop
  only once they are done too. An empty queue says nothing about work that never entered it.
- When you did work, or still_waiting was not zero, call backlog_report before you finish
  and say what is still waiting. A backlog
  nobody reports is a backlog nobody fixes — this system once hid nine thousand
  unplanned people behind a routine that cheerfully said "nothing to do".

How to use your sub-routines:

Each numbered step below is a sub-routine. Run it as its own sub-agent, in parallel
where the steps are independent, and give each one only the slice it needs. Ask each
to return a short summary — counts, and anything a person would want to know — never
its full working. Your own job is to split the work, read the summaries and write one
line of run notes. Do not do the per-person work yourself: your context is the thing
that runs out, and once it does the rest of the hour's work is lost.

Start a wave's sub-agents together in one message, each with run_in_background false,
so their reports come back to you together when the wave ends. Never poll while they
work: no ReadNotifications, ListAgents, ScheduleWakeup or sleeps between checks. Every
check re-reads your whole context, and a run that checked every few seconds spent more
on waiting than on the work (2026-09-23).`;

  return [
    {
      key: "acquire",
      name: "1 — Acquire",
      cron: DEFAULT_CRONS.acquire,
      human: "every hour, at :34",
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
  Run this on every run. next_work("plan") with limit 20. Each item is one lead in a
  campaign that plans every person. plan_goal is this routine's tool: before
  2026-09-16 it was wrongly refused to Acquire, so errors in routine_status or run
  history saying otherwise are out of date and are not a reason to skip this step.
  One sub-agent per lead, all in one wave, until the slice is
  done. Each one: lead_card, then plan_goal, then finish_work for that job. If
  plan_goal refuses a plan, read the reason, fix the plan and call it again. When the
  same reason comes back after you fixed it, or after five refusals, leave that lead:
  do not finish_work it, and return the refusal in one line so it reaches your notes.
  It comes back next run with a fresh card. A refusal naming the routine itself is
  worth stopping the whole run for.

  Where lead_card shows goal.rolling true, the campaign plans one or two touches at a
  time. The item's reason says why you are here: first_rolling_plan (their welcome has
  gone out), checkpoint:window_closed (the last touch had its time and got no answer),
  checkpoint:signal (they clicked or replied), checkpoint:after_fallback (no plan came in
  time and a fixed email went instead). Read lead_card's writing block first: their
  words, the facts the product can truly claim, every idea they already had and what
  came of it, what has worked and failed for leads like them, the learning notes, and
  how much this group is trying new ideas.
  Read writing.lead_type before anything else: it says what kind of people this campaign
  holds and how hard to push. In a hot campaign (they filled in our own form and asked
  about the product) every step leads to signing up or a call: each email sells one
  result in about 50 words, with the price. writing.lead_type.sequence lists the hooks, each
  marked sent or not: daily_question, hidden_bill, office_habit, just_ask,
  found_out_late, no_watching, closing. Plan two not yet sent that fit this lead best
  (not a fixed order), after_days 1 and 2, with hook set to its name and a theme that
  joins it to the idea from the idea bank that fits this lead (the 8pm update calls,
  the punch machine, the Monday Excel report). The last step a campaign has room for is
  hook "closing".
  Where writing.ideas is on the card, start every step from the idea bank, then the hook.
  The bank is there for you to learn from, not a menu and not copy to retell. Each idea
  shows a pattern (why it lands with an Indian founder), its proof (what TeamGrid really
  does about it) and also: other shapes the same pattern can take. Learn the pattern,
  then plan the moment that fits this lead: the idea as told, one of its other shapes, or
  a new shape you find in their business and their week. The 8pm status calls (#7) could
  just as well be the Saturday WhatsApp round-up, the 7pm sheet every team fills, or
  something only their office does. The shape can change; the proof cannot.
  writing.ideas.best_fit is the bank's top 8 for this lead (their words, role, segment),
  and others lists the rest. Each best_fit idea comes with its pattern, other shapes, the
  hook that lands it, its proof and the sample card that can show it; used_this_week
  says how many other leads in this campaign got it. You may blend two ideas; every step
  names idea_refs, the ideas you learned from. Two leads should rarely get the same
  shape: skip an idea in used_a_lot_this_week unless nothing else fits, and plan_goal
  refuses a step whose ideas are all at the campaign's weekly cap, one this lead already
  had, or a number the bank marks unusable. The theme is the moment you chose, in their
  words, in a few words.
  In a cold campaign, teach first and ask
  a question. Otherwise:
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
  Nobody reads a long mail (the manager's review, 2026-09-22): the subject and the first
  line are the hook, and the whole mail is about 50 words, never more than 75.
  subject    required: a ₹ figure or their own problem in their words, 25 to 55
             characters ("Is 1 client costing you ₹1.68 lakh a year?").
  preheader  optional, under 90 characters, adds to the subject.
  opening    the problem and what it costs, one line under 90 characters. Bold; in
             plain text it is the inbox preview, so it never repeats the subject.
  scene      1 or 2 short lines: the ₹ example, said to be an example. At most two
             **bold** figures.
  reveal     1 or 2 lines on what TeamGrid does about it, as a result they get, saying
             once that it is a small app on their office computers. Shown between thin
             lines with TeamGrid's name in the brand shade.
  question   on a link ask, the price from writing.facts.plans, shown bold in a box:
             "₹299 per person a month." with the total for their team size when known,
             or "No card needed to try." ₹649 for anything on the Advanced plan; the price,
             never the plan name. On a reply ask, one question they can answer in a line.
  ps         "P.S. Reply "call" and we will call you." (or the free trial, where the
             question already asks for the call).
  limit      only where most of their work is away from a computer (site visits),
             one short line. The privacy line (no screenshots, nothing people type is
             recorded) only in the no_watching email or to someone who asked.
  cta_text   "Try it free for 7 days" (the default on a link ask): the words say where
             the button goes.
  link_page  on a link ask, a page from writing.context when it fits this lead better
             than the start link: pages_for_this_lead first, the comparison page for a
             tool they use, pricing when cost is the question. The button goes there.
             Leave it out when nothing fits; compose_batch refuses a page not listed.
  timeline / reply_options
             two layouts on test. lead_card writing.layout_tests gives this lead's arm
             for each, fixed for good; follow it. Timeline (story ideas only): 2 to 4
             moments, {when: "Monday", what: "the drawing waits for approval."}.
             Reply options (reply asks only): 2 to 4 short answers to the question,
             shown as "Reply with one number:" and "1 = ..." lines.
  No shows list and no cost_lines box in hot or warm emails: a list of features reads
  as a brochure, and the numbers belong in the bold lines.
  Plain-text rules: quantities as digits ("5 days", "9 hours"), only these symbols:
  → – × ÷ = ₹ • ✓ (never ✔ ☑ ➡ ▶ ⚠ ™, styled letters or emoji).
  Words a shop owner uses, sentences of 16 words or fewer: customer, not lead or
  enquiry; price, not quote; "keeps track of every customer", not CRM; "nobody has
  replied", not "goes quiet"; "too busy", not overloaded; "new people", not new hires;
  "fill any sheet", not timesheet; and the plain word from writing.plain_words. No
  feature names (Founder's Report, Anomaly Feed): say what they get.
  lead_type  read writing.lead_type first; its default_ask, rules and sequence override
             the defaults here. Pick the hook and the idea that fit this lead, then write
             the short selling email above. Indian office words ("any update?", WFH,
             late mark, ₹ lakh) from writing.phrases. No colours or screen words, no spy
             words, no customer quotes, no thinking questions ("Which buyer would top
             that list?"). compose_batch refuses a hot or warm link email with no reveal,
             no price, a shows list, screen words, or a reply-only ask outside the hooks
             the type allows. A sample card (receipt) only in a designed ("html") email,
             2 to 3 lines from writing.facts.samples, counted in the words.
  format     decided per person and per mail; every format carries the same short words:
             1 "text" for a reply-only ask: a plain note, no link, reads as a person.
             2 their own record (lead_card engagement_by_format): reuse a format they
               clicked; after two or more sends, prefer the one they open.
             3 "html" (the designed look, a picture on top that shows the problem in
               numbers) for a lead who has opened our mail before.
             4 "letter" (HTML that looks typed, one button) for a lead who has not
               opened anything yet, and always for trust and privacy topics.
             When unsure, letter. format_why names the rule and the evidence.
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
message (the P.S. offer to reply "call" is a second route, not a second ask); compose_batch refuses a reply ask that does not end on a question, and the
engine refuses one that carries a link.

The subject. Twenty to sixty characters, carrying a number, their own metric or a
question — "TeamGrid on 11 people, week one", not "Welcome to TeamGrid" and not the
name of a feature. The product name may lead the subject where it earns the open, on a
first touch or a price mail; it is not a substitute for a reason to open. Never open a
subject with "welcome" to somebody who has not signed up, and never put their first
name in it on its own.

2.1 compose-tier1
  next_work("compose") with limit 15. One sub-agent per person, all in one wave.
  Each one: lead_card with view "write" for context, then compose_batch for the step it
  names. The write view is the card cut to what a mail is built from, small enough to
  read in one go: read it whole, never piece by piece with jq or scripts.
  compose_batch counts the words, the sentence lengths and the symbols itself and
  lists every problem in one reply, so never write a script to count or check them:
  send the mail, fix everything the reply lists, and send it again.
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
  On your first run of the day, and on any run that composed someone, call
  backlog_report; skip it on other empty runs. If the compose queue is empty but people are still in flight,
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
      human: "every 2 hours at :30, 10:00–20:00 IST",
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
  playbook edit is worth more than thirty rescued individuals.

3.4 lost-reader
  This step does not come from the queue, so run it on every run, including one where
  next_work("escalate") is empty and there is nothing else to do. It was written as a
  step like the others and on 2026-09-24 a run with an empty queue stopped before
  reaching it, leaving a lead asleep with a message still waiting behind them.
  sweep("react") carries lost_in_crm: leads the sales team closed as lost whose
  reason has not been read under the current rule. Their queued messages keep
  going out until you do, so read the words the rep typed and call classify_lost
  for each. A row carrying previous_bucket was read under an older rule and is in
  front of you again; answer it even if the verdict does not change.
  The reason is the whole evidence, and the buckets are taken in order — stop at
  the first one the words support, because one sentence often carries two signals:
    1 wrong_need  a want we do not sell. Its need field records it in their words,
                  because those words are counted across leads and become the case
                  for building it.
    2 competitor  bought elsewhere, or happy with what they have.
    3 refused     they said no in words and named neither a want nor an
                  alternative. "He is not interested and has not enquired for the
                  product" is this, not reachable: the refusal is the signal, and
                  the rest is the rep explaining it.
    4 reachable   only what none of the first three fit. "Tried a few times, but
                  contact number does not exists" is nobody getting through.
                  "IT Company." is not a reason at all. Nothing changes for these,
                  which keeps open the one channel still reaching them.`,
    },
    {
      key: "close",
      name: "4 — Close",
      cron: DEFAULT_CRONS.close,
      human: "every 2 hours at :45, 11:15–21:15 IST",
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
      human: "once a day, 07:50 UTC (13:20 IST)",
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
It takes no next_work slice, so the rule about stopping on an empty slice does not
apply here: register, then run every step below.

5.1 gaps-filler
  setup_gaps for each product. If gaps is empty, say "setup is complete" and move on.
  Fill what you can: missing ladder rungs get get_brand first so the copy suits the
  design, then upsert_template, always status "draft", checked with preview_template
  before you move on. A campaign with no verification plan gets verifiers then
  set_checks.
  A no_context or context_stale gap means reading the product's website: read_site
  for the map, then read_site with the selling pages (home, features, solutions,
  comparisons, pricing, security, about) a few at a time, then save_context with
  everything they say. Tag each solution page with the segments it is written for.
  Write only what the pages say. On a refresh, change_note names what moved — a new
  price, a new page, a claim gone — and anything that contradicts writing.facts goes
  to 5.4 as a question for the owner; never change the facts yourself.
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
    {
      key: "linkedin",
      name: "6 — LinkedIn",
      cron: DEFAULT_CRONS.linkedin,
      human: "every 2 hours at :40, 10:10–20:10 IST",
      // Only products with a campaign that hands its LinkedIn touches to Claude need it.
      essential: false,
      job: "In campaigns that hand LinkedIn to Claude: find each lead's profile, who to invite, what to write once they accept, and how to answer when they write back.",
      example: [
        "Twelve form leads arrive with only an email: nine profiles are found by name and company, two wait for a person to confirm, one has none.",
        "A list of forty profiles arrives: thirty-six are founders and managers and are invited; four are company pages and recruiters and are skipped, each with its reason.",
        "Meera accepted this morning: her first message names the evening update calls a twelve-person agency makes, and asks how she hears what got finished.",
        "Arjun wrote back asking how hours are counted: the answer comes from the product's facts and waits in Review.",
      ],
      prompt: `${scope}

${registration("linkedin")}

${contract}

Your work is LinkedIn, in campaigns that hand their LinkedIn touches to you. The engine
does everything that runs on a clock: it sends invites and messages inside each
account's limits and sending hours, sees who accepted, and gives up on invites nobody
accepts. What it cannot do is judge a person, and that is what each item asks of you.

You speak as the product, never as the person whose account sends: "we", in the voice
linkedin_card gives as product.voice, with no sign-off, no person's name, never the
lead's company name and never how they arrived. Every fact comes from product.facts;
never invent a capability, a customer or a number.

6.1 leads
  next_work("linkedin") with limit 15. One sub-agent per lead, all in one wave. Each one reads linkedin_card for the item's
  goal_instance_id and acts on needs.kind, not on the item's reason, which can be older
  than the card:

  find    They have no LinkedIn profile on record; most leads arrive from a form with
          only an email. Find it with WebSearch: site:linkedin.com/in "<name>" "<company>",
          the company taken from lead.said, lead.company_site or lead.email_domain
          (acme-solar.in is "Acme Solar"); then the first name with the company; then
          the company's LinkedIn page and its people. Read each result's title and
          headline against the lead: same name and current company is sure; same name
          with a company, city or role that fits and nothing against it is likely; a
          plausible one you cannot confirm is unsure; nothing, or only people who are
          plainly someone else, is none. Record it with save_linkedin, with the result's
          title as evidence. Never make up or complete a URL you did not see in a result.
          After sure or likely, read linkedin_card again and do the pick below.

  pick    Decide whether to invite them at all, with pick_linkedin. Invite anyone who
          plausibly runs or manages a team the product serves (lead.role, lead.segment,
          what their site says). Skip a company page, a student, a recruiter, a
          competitor, or someone plainly outside the product's segments, and say why in
          one sentence. The invite goes without a note unless the account allows one;
          then the note names their situation in a line, never their profile.

  plan    They accepted, or the last message had its days without an answer. Write the
          next one or two messages with plan_linkedin, each built on one idea from
          linkedin_card ideas (the ones they have not had, closest fit first;
          linkedin_results_by_idea shows what got answers on LinkedIn). Each message:
            - the first after an accept is 150 to 200 characters: one line on a moment
              from their week the idea describes, then one question they can answer in
              a line;
            - no link and no pitch until they have answered; ask "link" with
              {{trial_link}} only after they answered, or on the last message allowed,
              and set link_page to a page from product.context when one fits them
              better than the start link;
            - one question, plain sentences, no list, bold, emoji or sign-off;
            - a different idea and different words from every earlier message, and no
              sentence another lead got this week.
          after_days is 0 to 2 for a first message and 3 to 5 for each later one. The
          why says, in one sentence a person reading the lead page understands, what
          about this lead put that idea there. Write three openings before you choose
          one; keep the one a busy owner would answer. plan_linkedin refuses anything
          outside the rules with every reason at once: fix them and call it again.

  answer  They wrote back. Read their words in linkedin.open_replies and the history,
          and answer what they asked with answer_linkedin, plainly and from
          product.facts. Where they ask to try it, ask "link". Where they ask about
          price or how data is kept, ask "link" with link_page set to the pricing or
          security page from product.context. Where they say not now,
          thank them and ask nothing. Where the facts cannot answer them, say we will
          find out rather than guess.

  wait or end   Nothing is needed; finish the item.

  finish_work each item once its lead is done.

6.2 notes
  One line of run notes: how many profiles were found (sure, likely, unsure, none), how
  many were invited and skipped, how many messages planned, how many answers written, and
  any refusal you could not fix, with its reason.`,
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
