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
 * One hour is the floor Claude Code routines allow, and all three sit on it: a lead who
 * arrives at 09:05 should not wait until 11:20 for a pipeline. The minutes are staggered
 * so the three never fire together and race each other over the same people.
 */
export const DEFAULT_CRONS: Record<RoutineKey, string> = {
  monitor: "5 * * * *",
  plan: "20 * * * *",
  compose: "35 * * * *",
  // Setup gaps are a day-scale problem, not an hour-scale one. Hourly would mean
  // twenty-four notifications about the same missing lead source.
  groom: "50 7 * * *",
};

/**
 * The three routines, prompt and all.
 *
 * They live here rather than in the page because three separate things need them: the page
 * that tells you what to paste, the tool that records what you scheduled, and the check
 * that decides whether it is late.
 */
export function routineCatalog(productId: string): RoutineDef[] {
  const preamble = `Product ${productId} on the conversion engine.`;
  const registration = (key: RoutineKey) =>
    `Start by calling register_routine with product_id "${productId}", routine "${key}" and the
cron you scheduled this session on. It takes a moment and it is what lets the console
show when you last ran and when you are due next. If you are late, that is how anyone
finds out.`;

  return [
    {
      key: "monitor",
      name: "Monitor",
      cron: DEFAULT_CRONS.monitor,
      human: "every hour, at :05",
      essential: true,
      job: "Every person in an active campaign: where are they, are they done, and what happens next. Verification and monitoring are the same question about the same person, so they are answered in one pass.",
      example: [
        "Priya's probes show an account and two sessions — marked succeeded, her two queued messages cancelled.",
        "Rahul has not moved in nine days and the profitability angle failed twice, so his remaining steps are replaced with the surveillance objection.",
        "Deepa replied \"ask in Q3\" — campaign closed, cooling until July, her reason kept for whoever picks her up then.",
      ],
      prompt: `${preamble}

${registration("monitor")}

Every run:
1. sweep with product_id "${productId}" and scope "monitor".
2. If total_work_items is 0, stop and say "nothing to monitor".
3. For each person under in_flight, read last_probes — what the tools actually
   returned — alongside check_results and their last message. Decide:
     succeeded  the evidence plainly shows it. Not "probably".
     failed     a real ending: they said no, or the budget and deadline are
                spent. Never because a check has simply not passed yet.
     continue   still running. Say in one line where they are.
   Submit them together with mark_state. It refuses "succeeded" unless every
   check the campaign defines has actually passed, so if it refuses, the answer
   is to repair the check — never to route around it.
4. Where someone is off-plan — stalled, or a signal the plan did not expect —
   call plan_goal with a new version and say why the old one is being replaced.
5. For each reply: read it, then record_reply with a grounded answer. Never
   invent a capability to close someone.
6. For each undetermined check: verify_person, read the raw response, and
   resolve_check only if it plainly supports the verdict.
7. On your first run of the day, look at both verification lists.
   verification_looks_wrong is two weeks with nothing passing — usually a check
   bound to the wrong tool.
   verification_too_easy is the more dangerous one: a check that has passed for
   everybody it has ever run on. That is not evidence, it is a constant, and it
   ends campaigns for people who have done nothing. Read one probe, compare the
   scope the args asked for against the scope the response says it used — a
   provider that ignores an argument it does not have the privilege for will
   answer about your own account instead. Repair both with verifiers and
   set_checks.`,
    },
    {
      key: "plan",
      name: "Plan",
      cron: DEFAULT_CRONS.plan,
      human: "every hour, at :20",
      essential: true,
      job: "New people get understood and given a pipeline. New campaigns get a verification plan — which can only happen here, because the browser that created them cannot call Claude.",
      example: [
        "Twelve leads arrive overnight and none of them mean anything yet.",
        "Priya reads as an engineering leader with no honest view of where the team's time goes, so her sequence opens by showing exactly that.",
        "Deepa in HR gets a different one entirely, opening on audit-ready attendance.",
      ],
      prompt: `${preamble}

${registration("plan")}

Every run:
1. sweep with product_id "${productId}" and scope "plan".
2. If total_work_items is 0, stop.
3. For anything under need_verification_plan: it names verify_connection_id —
   the source whoever created it said holds the truth. Call verifiers with that
   connection_id, read the tools it exposes, and work out which answer the
   success sentence. Respect any hint. Then set_checks. Until this exists the
   campaign cannot mark anyone as succeeded.
   Every check needs an argument that identifies the person — $person.email,
   $person.id, something they alone match. set_checks tries each check against
   two different people and refuses any that answers identically for both,
   because a check that cannot tell two people apart will pass for everyone.
   Beware arguments a provider accepts and then ignores: many scoping parameters
   need an admin privilege, and without it the tool answers about your own
   account and echoes the scope it really used back in the response. Read that
   echo before trusting a check.
4. Classify unclassified people in batches — lead_card for context, then submit
   them all in one classify call.
5. For each campaign under need_plan: lead_card, then plan_goal.
   Everyone gets a real sequence. Spend the campaign's touch budget, not a
   cautious fraction of it — an unspent budget converts nobody.
   Low confidence means try harder, not go quiet. Someone you read at 5% fit
   gets the tightest gaps in their band and the boldest, most attention-earning
   angles, because a polite generic message will not land on them and silence
   loses them anyway. Someone you are sure of gets a calmer, straighter
   sequence; the cadence bands already give them the wider gaps.
   Use only channels the campaign allows; lead_card lists what is connected and
   what each can carry. Stay inside the budget, the weekly cap and the cadence
   band for that temperature. Those are the guardrails — work at their edge, not
   half-way inside them.
6. Stop after 40 people and leave the rest for the next run.`,
    },
    {
      key: "compose",
      name: "Compose",
      cron: DEFAULT_CRONS.compose,
      human: "every hour, at :35",
      essential: false,
      job: "Write the messages about to go out — in the shape of the channel each one is going on. Only the next two days' worth.",
      example: [
        "Rahul's replanned step is due Thursday on email: subject line, around 140 words, a link, an opt-out.",
        "His step after that is WhatsApp: about 45 words, no link, and outside the 24-hour window an approved template.",
        "Same angle, two different pieces of writing — because the channel decides the shape.",
      ],
      prompt: `${preamble}

${registration("compose")}

Every run:
1. sweep with product_id "${productId}" and scope "compose".
2. If total_work_items is 0, stop.
3. For each low buffer: compose_batch for the steps it names. Each one carries
   next_step and steps_due_in_window — the sweep has already filtered to what
   falls inside 48 hours, so write those and nothing further ahead. A message
   written now for day 9 is usually wasted, because the person signs up or
   unsubscribes first.
4. Write to the channel's shape. lead_card lists each channel's real limits:
   an email carries a subject, a body of a few hundred words, a link and an
   opt-out; a WhatsApp message is a couple of sentences with no link, and
   outside its reply window it must use an approved template. The same angle
   becomes two different pieces of writing.
5. Read their prior touches. Never repeat a claim already made to them, never
   contradict one, and let the register escalate naturally across a sequence.
6. The lower your confidence in someone, the harder the opening line has to
   work. Be specific and a little cheeky rather than polite and generic — a
   message that reads like every other message gets deleted unread. This never
   licenses a false claim: no invented capability, no number the product cannot
   back, nothing the voice rules forbid.
7. Stop after 30 touches.`,
    },
    {
      key: "groom",
      name: "Groom",
      cron: DEFAULT_CRONS.groom,
      human: "once a day, 07:50",
      essential: false,
      job: "Finishes what setup left half-done, and asks for the rest exactly once. A product with a brand kit but no day-three template, or four campaigns still drafted a week after they were written, is not broken — it is waiting on somebody, and nothing else in the system says so.",
      example: [
        "Priya's product has a welcome and nothing after it, so the day-three nudge and the last call get written in her brand voice and left as drafts.",
        "Her four campaigns have sat unstarted for six days — one notification says so, naming the lead source they are all waiting on.",
        "Tomorrow it stays quiet about the same four, because it already asked.",
      ],
      prompt: `${preamble}

${registration("groom")}

This runs once a day. It finishes setup nobody came back to, and it asks for
what only a person can give — once, not daily.

Every run:
1. setup_gaps with product_id "${productId}". It returns what is missing and
   what is merely unfinished. If gaps is empty, stop and say "setup is complete".
2. Fill what you can yourself:
   - Missing templates in the ladder: get_brand first so the copy suits the
     design, then upsert_template for each, always status "draft". Check each
     one with preview_template before moving on.
   - A campaign with no plan: plan_goal, as the Plan routine would.
   Everything you write stays a draft. This routine never activates anything —
   a campaign that starts sending because a scheduled session decided it was
   ready is the worst possible surprise.
3. For what only a person can supply — a lead source, a send channel, a real
   trial link, a brand nobody has confirmed — call notify_owner once, with all
   of it in one message. It is deduped for seven days, so repeating yourself
   costs you nothing and gains them nothing.
4. Say plainly what you drafted and what you are waiting on.`,
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
