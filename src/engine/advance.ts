import { ObjectId, type Document } from "mongodb";
import { engineRenderedKeysFor } from "./engineSteps.js";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { dueAtFor, type CadenceBand } from "./cadence.js";
import { PRIORITY, enqueueMany } from "./queue.js";
import { channelKinds, pickChannelFrom, loadChannels, persistAssignments, persistInstanceMailboxes, skipReason, type PooledChannel } from "./channels.js";
import type { ChannelKey } from "../schemas/common.js";
import { checkpoint, effectiveBand, frameKeyOf, isRolling, isRollingPlan, leadTypeOf, perLeadPlanOf, type CheckpointDecision } from "./rolling.js";

/**
 * Turning a plan into messages, on the clock, for everybody.
 *
 * Until now the only thing that could produce a follow-up was a Claude session: the plan
 * named an angle, and a session had to write the words before an action existed at all.
 * That put a model in the path of every touch for every person, which is why thirty touches
 * an hour had to cover fifteen hundred a day, and why a person whose session never came
 * round simply stopped receiving mail with no error anywhere.
 *
 * Here the engine creates the action from the plan step, and what varies is only who fills
 * the slot. Most people get the template's own copy, merged with their name and their
 * segment's pain — which is what they were getting anyway, since the composed copy was
 * being discarded at render time. The few who have earned it get a session's writing.
 */

export type Tier = 1 | 2 | 3;

/** How long a lead in a campaign that plans each person waits for that plan. */
const PLAN_WAIT_MS = 12 * 3_600_000;

/** How long a step waits for a session's words before the template's own go out. */
const COMPOSE_WAIT_MS = 6 * 3_600_000;

export interface AdvanceSummary {
  examined: number;
  queued: number;
  handedToClaude: number;
  parked: number;
  /** Rolling campaigns: leads whose next one or two touches were asked for at a checkpoint. */
  plansAsked: number;
  /** Rolling campaigns: fixed emails sent because a plan or its words never arrived. */
  fallbacks: number;
  skipped: Array<{ goalInstanceId: string; reason: string }>;
}

/**
 * Which people are worth a model call.
 *
 * Tier 1 is not "our best leads" — it is people who have done something we can point at, or
 * who fit well enough that a generic message is a waste of the one chance. Everyone else is
 * tier 2, which is not a lesser message: it renders through the same templates, the same
 * brand kit, the same claims validation and the same governor.
 */
export function tierFor(person: Document, goalInstance: Document): Tier {
  const budget = (goalInstance.spent as { touches?: number } | undefined)?.touches ?? 0;
  const deadline = goalInstance.deadline ? new Date(String(goalInstance.deadline)) : undefined;
  if (deadline && deadline <= new Date()) return 3;

  const band = (person.temp as { band?: string } | undefined)?.band;
  if (band === "dead") return 3;
  if (person.lifecycle === "suppressed" || person.suppressedAt) return 3;

  const belief = (person.belief as { icpFit?: number; fitKnown?: boolean } | undefined) ?? {};
  const replied = Boolean(person.lastReplyAt);
  if (band === "hot" || replied) return 1;
  // A strong fit is worth one good message rather than five generic ones, but only while
  // the sequence still has room to use it.
  if ((belief.icpFit ?? 0) >= 0.7 && belief.fitKnown !== false && budget < 4) return 1;
  return 2;
}

/**
 * The step a plan is up to: the lowest-numbered one nothing has been written for yet.
 *
 * With one exception, at the very start of a sequence. The engine queues a first touch the
 * moment a lead lands — it does not wait for a plan, because speed to lead is worth more
 * than the personalisation a session would add — and a plan written afterwards almost
 * always opens with a welcome of its own. Both are correct in isolation and together they
 * put the identical "your workspace is ready" in front of the same person twice.
 *
 * So while nothing from the plan has been written yet, a leading step whose angle has
 * already been delivered is treated as spent and skipped. Only the leading steps, and only
 * before the plan has done anything: past that point a repeated angle can be deliberate —
 * an angle somebody clicked is not spent, it reached them and the ask was wrong — and that
 * is a judgement for the routine that rewrote their plan, not for this loop.
 */
export interface StepEngagement {
  opened: boolean;
  clicked: boolean;
  band?: string;
}

/**
 * Whether a step's gate lets it fire for this person right now.
 *
 *   no_open    only while nothing we sent has been opened — a second first impression
 *   no_click   only while nothing has been clicked
 *   warm       only once they are warm or hot
 *   cold       only while they are neither
 *
 * A gate that fails skips the step for good: the situation it was written for did not
 * happen. Unknown gates pass, so an older plan keeps running.
 */
export function gateOpen(gate: unknown, e: StepEngagement | undefined): boolean {
  const g = String(gate ?? "").trim().toLowerCase();
  if (!g || !e) return true;
  const warm = e.band === "warm" || e.band === "hot";
  if (g === "no_open") return !e.opened;
  if (g === "no_click") return !e.clicked;
  if (g === "warm") return warm;
  if (g === "cold") return !warm;
  return true;
}

export function nextStep(plan: Document | null, written: Set<number>, delivered: Set<string> = new Set(), engagement?: StepEngagement): Document | null {
  const steps = ((plan?.steps ?? []) as Document[]).slice().sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
  const planStarted = steps.some((step) => written.has(Number(step.id ?? step.step_id ?? 0)));

  for (const step of steps) {
    const id = Number(step.id ?? step.step_id ?? 0);
    if (!Number.isFinite(id) || id === 0) continue;
    if (written.has(id)) continue;
    if (!planStarted && delivered.has(String(step.angle ?? "").toLowerCase())) continue;
    if (!gateOpen(step.gate, engagement)) continue;
    return { ...step, id };
  }
  return null;
}

/**
 * Walks active campaigns and gives each person their next message.
 *
 * Bounded per run and ordered by who has waited longest, so a product with fifty thousand
 * people in flight makes progress on all of them across successive ticks rather than
 * repeatedly serving whichever rows the index happened to return first.
 */
export async function advance(
  orgId: string,
  productId: string,
  limit = 100,
  now = new Date(),
  deadline = Date.now() + 10_000,
): Promise<AdvanceSummary> {
  const db = await getDb();
  const summary: AdvanceSummary = { examined: 0, queued: 0, handedToClaude: 0, parked: 0, plansAsked: 0, fallbacks: 0, skipped: [] };
  const s = { orgId, productId };

  const instances = await db
    .collection(C.goalInstances)
    .find(
      { ...s, status: "active", currentPlanId: { $exists: true } },
      { projection: { personId: 1, goalKey: 1, currentPlanId: 1, spent: 1, deadline: 1, startedAt: 1, createdAt: 1, handedOverAt: 1, checkpointAskedAt: 1 } },
    )
    .sort({ lastAdvancedAt: 1, startedAt: 1 })
    .limit(limit)
    .toArray();
  if (instances.length === 0) return summary;
  // The cluster this runs against is shared, and a query that usually costs a second has
  // been seen to cost twenty. Checking here as well as in the loop means a slow moment
  // costs a batch rather than the whole tick, which still has mail to reconcile after this.
  if (Date.now() > deadline) return summary;

  const instanceIds = instances.map((i) => String(i._id));

  // Everything this loop needs, read in five queries rather than five per person.
  //
  // The per-person version was correct and far too slow to run on a minute clock: a round
  // trip to a hosted cluster is about forty milliseconds, so two hundred people at five
  // round trips each is thirty-nine seconds inside a function the platform kills at sixty.
  // The tick would send its mail, then die before recording anything — which from outside
  // looks exactly like a system that is working.
  // Projected down to what the decision actually reads. A person document is about 1.5KB
  // and only six of its fields matter here; over two hundred people that is the difference
  // between a payload worth waiting for and one worth timing out over.
  const [goals, people, plans, actionRows] = await Promise.all([
    db.collection(C.goals).find(s).toArray(),
    db
      .collection(C.people)
      .find(
        { _id: { $in: instances.map((i) => new ObjectId(String(i.personId))) } },
        { projection: { temp: 1, belief: 1, lifecycle: 1, suppressedAt: 1, lastReplyAt: 1, lastContactedAt: 1, consent: 1, stage: 1, needsClassification: 1, "enrichment.form.timeline": 1 } },
      )
      .toArray(),
    db
      .collection(C.plans)
      .find(
        { _id: { $in: instances.map((i) => new ObjectId(String(i.currentPlanId))) } },
        { projection: { steps: 1, createdBy: 1, createdAt: 1, rolling: 1 } },
      )
      .toArray(),
    db
      .collection(C.actions)
      .find(
        { ...s, goalInstanceId: { $in: instanceIds } },
        { projection: { goalInstanceId: 1, planStepId: 1, status: 1, angle: 1, channel: 1, sentAt: 1, firstOpenedAt: 1, firstClickedAt: 1, firstRepliedAt: 1 } },
      )
      .toArray(),
  ]);

  // How long each person's written message has been waiting on a session.
  const composeJobs = await db
    .collection(C.workQueue)
    .find(
      { orgId, kind: "compose", subjectId: { $in: instanceIds }, status: { $in: ["queued", "ready", "running"] } },
      { projection: { subjectId: 1, createdAt: 1 } },
    )
    .toArray();
  const composeAskedAt = new Map(composeJobs.map((j) => [String(j.subjectId), new Date(String(j.createdAt)).getTime()]));

  const goalByKey = new Map(goals.map((g) => [String(g.key), g]));
  const personById = new Map(people.map((p) => [String(p._id), p]));
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  const pendingBy = new Map<string, number>();
  const writtenBy = new Map<string, Set<number>>();
  /** What this person did with what we sent, for the gates on their remaining steps. */
  const engagementBy = new Map<string, { opened: boolean; clicked: boolean }>();
  /** Angles this person has already been given, whatever produced them. */
  const deliveredBy = new Map<string, Set<string>>();
  /** The last touch that went out in each campaign, and the latest click or reply, for checkpoints. */
  const lastSentBy = new Map<string, { at: Date; channel: string }>();
  const lastSignalBy = new Map<string, Date>();
  for (const action of actionRows) {
    const key = String(action.goalInstanceId);
    if (["sent", "dispatched"].includes(String(action.status)) && action.sentAt) {
      const at = new Date(String(action.sentAt));
      const seen = lastSentBy.get(key);
      if (!seen || at > seen.at) lastSentBy.set(key, { at, channel: String(action.channel ?? "email") });
    }
    for (const field of ["firstClickedAt", "firstRepliedAt"] as const) {
      if (!action[field]) continue;
      const at = new Date(String(action[field]));
      const seen = lastSignalBy.get(key);
      if (!seen || at > seen) lastSignalBy.set(key, at);
    }
    if (["queued", "awaiting_approval", "sending"].includes(String(action.status))) {
      pendingBy.set(key, (pendingBy.get(key) ?? 0) + 1);
    }
    if (action.firstOpenedAt || action.firstClickedAt) {
      const e = engagementBy.get(key) ?? { opened: false, clicked: false };
      engagementBy.set(key, { opened: e.opened || Boolean(action.firstOpenedAt), clicked: e.clicked || Boolean(action.firstClickedAt) });
    }
    const step = Number(action.planStepId);
    if (Number.isFinite(step)) {
      const set = writtenBy.get(key) ?? new Set<number>();
      set.add(step);
      writtenBy.set(key, set);
    }
    // A message that was skipped or failed never reached anyone, so its angle is not spent.
    if (["queued", "awaiting_approval", "sending", "sent", "dispatched"].includes(String(action.status))) {
      const angles = deliveredBy.get(key) ?? new Set<string>();
      angles.add(String(action.angle ?? "").toLowerCase());
      deliveredBy.set(key, angles);
    }
  }

  // Channels are the same handful of documents for everyone in the batch, so they are read
  // once per campaign and the per-person decision is made in memory.
  /** Steps the engine renders itself: a family of variants, or a template with no slot. */
  const familyKeys = await engineRenderedKeysFor(orgId, productId);

  const channelsByGoal = new Map<string, PooledChannel[]>();
  const kinds = await channelKinds(orgId, productId);
  for (const goal of goals) {
    channelsByGoal.set(
      String(goal.key),
      await loadChannels(
        orgId,
        productId,
        (goal.allowedChannels ?? ["email"]) as ChannelKey[],
        (goal.channelIds ?? []) as string[],
      ),
    );
  }

  const advancedIds: ObjectId[] = [];
  const toInsert: Document[] = [];
  // Mailboxes handed out in this pass, written back once at the end. The pick is already
  // counted in memory, so a batch spreads itself even before any of this reaches the
  // database.
  const assignments: Array<{ personId: string; channelId: string }> = [];
  // The same, written on the campaign: what this campaign sends this person from, kept
  // apart from what another campaign may be sending them from at the same time.
  const instanceMailboxes: Array<{ goalInstanceId: string; channelId: string }> = [];
  const handOver: Array<{ subjectId: string; payload: Record<string, unknown>; productId: string; campaignKey: string; priority: number }> = [];
  // Rolling campaigns: plans asked for at a checkpoint, and the instances to stamp with the ask.
  const planAsks: Array<{ subjectId: string; payload: Record<string, unknown>; productId: string; campaignKey: string; priority: number }> = [];
  const askedIds: ObjectId[] = [];

  for (const instance of instances) {
    if (Date.now() > deadline) break;
    summary.examined++;
    const goalInstanceId = String(instance._id);
    // Stamped whatever happens, so a campaign that cannot advance today drops to the back of
    // the queue instead of being re-examined on every single tick forever.
    advancedIds.push(instance._id as ObjectId);

    const goal = goalByKey.get(String(instance.goalKey));
    if (!goal) {
      summary.skipped.push({ goalInstanceId, reason: "campaign definition missing" });
      continue;
    }

    // Somebody booked a call: a person has the conversation now, and the next automated
    // chase would land in the middle of it. The campaign stays open so its checks can still
    // close it; only the sequence stops.
    if (instance.handedOverAt) {
      summary.parked++;
      continue;
    }

    const budget = (goal.budget ?? {}) as { touches?: number };
    const spent = Number((instance.spent as { touches?: number } | undefined)?.touches ?? 0);
    if (budget.touches !== undefined && spent >= budget.touches) {
      summary.parked++;
      continue;
    }

    // Anything already waiting means this person's next message exists. Writing a second one
    // now would put two messages in front of somebody who has read neither.
    if ((pendingBy.get(goalInstanceId) ?? 0) > 0) continue;

    const person = personById.get(String(instance.personId));
    if (!person) {
      summary.skipped.push({ goalInstanceId, reason: "person missing" });
      continue;
    }

    let tier = tierFor(person, instance);
    if (tier === 3) {
      summary.parked++;
      continue;
    }
    // A campaign can decide everyone in it is worth a written message — an ad-lead
    // campaign, where every person chose to click — and then the engine renders nothing
    // after the welcome; a session writes each step against what the person did.
    if (goal.composeAll === true) tier = 1;

    const plan = planById.get(String(instance.currentPlanId)) ?? null;
    const perLeadFamily = perLeadPlanOf(goal)?.family;
    const startedAt = new Date(String(instance.startedAt ?? instance.createdAt ?? now)).getTime();
    const bandNow = (person.temp as { band?: string } | undefined)?.band;
    const engagementNow = { ...(engagementBy.get(goalInstanceId) ?? { opened: false, clicked: false }), band: bandNow };

    // A campaign that plans one or two touches at a time. Its lead runs only a plan written
    // for that; anything older reads as spent, and a spent plan reaches a checkpoint where
    // the next one or two are asked for. A lead read as outside the product's customers is
    // planned too: the planner is told to ask one short question rather than pitch, which
    // is what the old re-qualify playbook did with less to go on.
    const rolling = isRolling(goal);
    let step: Document | null;
    let fallback = false;
    if (rolling) {
      if (person.needsClassification === true) {
        summary.skipped.push({ goalInstanceId, reason: "waiting to be read before the first plan" });
        continue;
      }
      step = isRollingPlan(plan)
        ? nextStep(plan, writtenBy.get(goalInstanceId) ?? new Set(), deliveredBy.get(goalInstanceId) ?? new Set(), engagementNow)
        : null;
      if (!step) {
        const askedAt = instance.checkpointAskedAt ? new Date(String(instance.checkpointAskedAt)) : null;
        const last = lastSentBy.get(goalInstanceId);
        // Somebody who wrote back is in a conversation, and React answers it. A planned touch
        // arriving beside that answer reads as nobody having read what they wrote. Once the
        // answer has gone out it is the last touch, and the window runs from there.
        const repliedAt = person.lastReplyAt ? new Date(String(person.lastReplyAt)) : null;
        if (repliedAt && (!last || repliedAt >= last.at)) {
          summary.skipped.push({ goalInstanceId, reason: "they replied; the conversation is being answered first" });
          continue;
        }
        // The first ask does not wait out a window: the welcome is not a question the next
        // plan depends on, and a lead who just arrived is the one most worth a quick second touch.
        const decision: CheckpointDecision = !askedAt
          ? { kind: "ask", reason: "nothing_sent" }
          : checkpoint({
              lastSentAt: last?.at ?? null,
              lastChannel: last?.channel,
              signalAt: lastSignalBy.get(goalInstanceId) ?? null,
              askedAt,
              planWrittenAt: isRollingPlan(plan) && plan?.createdAt ? new Date(String(plan.createdAt)) : null,
              now,
              leadType: leadTypeOf(goal),
            });
        if (decision.kind === "watch") {
          summary.skipped.push({ goalInstanceId, reason: `watching the last touch until ${decision.until.toISOString()}` });
          continue;
        }
        if (decision.kind === "waiting") {
          summary.skipped.push({ goalInstanceId, reason: "waiting for Claude to plan the next touch" });
          continue;
        }
        if (decision.kind === "ask") {
          planAsks.push({
            subjectId: goalInstanceId,
            payload: { goalInstanceId, personId: String(person._id), reason: askedAt ? `checkpoint:${decision.reason}` : "first_rolling_plan" },
            productId,
            campaignKey: String(instance.goalKey),
            priority: decision.reason === "signal" ? PRIORITY.urgent : PRIORITY.normal,
          });
          askedIds.push(instance._id as ObjectId);
          summary.plansAsked++;
          continue;
        }
        // No plan arrived in time. One fixed email the lead has not had goes instead, and the
        // plan is asked for again, so a routine that is down costs a lead one generic
        // message rather than silence.
        if (!perLeadFamily) {
          summary.skipped.push({ goalInstanceId, reason: "no plan arrived and the campaign has no fallback emails" });
          continue;
        }
        step = { id: 0, channel: "email", angle: perLeadFamily, templateKey: perLeadFamily, offsetDays: 1, why: "No plan was written in time for this lead, so an email they have not had went in its place." };
        fallback = true;
        planAsks.push({
          subjectId: goalInstanceId,
          payload: { goalInstanceId, personId: String(person._id), reason: "checkpoint:after_fallback" },
          productId,
          campaignKey: String(instance.goalKey),
          priority: PRIORITY.normal,
        });
        askedIds.push(instance._id as ObjectId);
      }
    } else {
      // A campaign that plans each lead waits for that plan instead of sending the standard
      // steps stamped on arrival. Only for half a day: a session that never comes round must
      // not leave the lead with nothing, so past that the standard steps run.
      if (perLeadFamily && plan?.createdBy === "playbook" && now.getTime() - startedAt < PLAN_WAIT_MS) {
        summary.skipped.push({ goalInstanceId, reason: "waiting for Claude to plan this lead" });
        continue;
      }
      step = nextStep(
        plan,
        writtenBy.get(goalInstanceId) ?? new Set(),
        deliveredBy.get(goalInstanceId) ?? new Set(),
        engagementNow,
      );
    }
    if (fallback) tier = 2;
    // A step that names a family of variants ("the next welcome they have not seen") is
    // the engine's to render: the variant IS the message, picked by segment and by what
    // has won. Handing it to a session would replace a tested first mail with freehand.
    // So is a step whose template has no slot: written copy would be dropped at render.
    if (step && tier === 1 && familyKeys.has(String(step.templateKey ?? ""))) tier = 2;
    // Written copy that has waited on a session for longer than a routine takes to come
    // round twice is not coming. The template's own words go out instead, and the waiting
    // job is finished by next_work once it sees the queued message.
    const askedAt = composeAskedAt.get(goalInstanceId);
    // In a rolling campaign the step renders through a frame whose slot is empty without a
    // session's words, so the fallback there is a fixed email the lead has not had.
    let composeLate = false;
    if (tier === 1 && askedAt !== undefined && now.getTime() - askedAt > COMPOSE_WAIT_MS) {
      tier = 2;
      composeLate = true;
    }
    if (!step) {
      summary.skipped.push({ goalInstanceId, reason: "plan exhausted" });
      continue;
    }

    // Paced at the campaign's lead type where that is warmer than the person's own reading.
    const band = effectiveBand(
      (person.temp as { band?: string } | undefined)?.band,
      leadTypeOf(goal),
      (person.enrichment as { form?: { timeline?: unknown } } | undefined)?.form?.timeline,
    );
    const dueAt = dueAtFor({
      offsetDays: Number(step.offsetDays ?? step.after_days ?? 3),
      band,
      lastContactedAt: person.lastContactedAt as Date | undefined,
      configured: goal.cadenceByTemp as Record<string, CadenceBand> | undefined,
      now,
    });

    // Tier 1 is handed to a session rather than written here. The action is not created yet:
    // whoever writes the copy also decides the shape, and creating an empty shell now would
    // race the session that is about to fill it.
    if (tier === 1) {
      handOver.push({
        subjectId: goalInstanceId,
        payload: { goalInstanceId, personId: String(person._id), stepId: step.id, dueAt },
        productId,
        campaignKey: String(instance.goalKey),
        priority: band === "hot" ? PRIORITY.urgent : PRIORITY.normal,
      });
      summary.handedToClaude++;
      continue;
    }

    // The campaign's allowed channels are the outer bound; the step's preference is tried
    // first inside it. A plan naming a channel the campaign never allowed is not honoured —
    // that is the campaign's decision to make, not a plan's.
    const allowed = (goal.allowedChannels ?? ["email"]) as ChannelKey[];
    const channels = channelsByGoal.get(String(goal.key)) ?? [];
    // This campaign's own mailbox for them first, and only then the one they hold from
    // wherever else they have been written to. An instance from before campaigns had their
    // own sender has none, which is why the person's is still read.
    const heldId = String(instance.channelId ?? person.assignedChannelId ?? "");
    const talker = {
      ...(person as Record<string, unknown>),
      assignedChannelId: instance.channelId ?? person.assignedChannelId,
      assignedChannelKey: kinds.get(heldId),
      leadType: leadTypeOf(goal),
    };
    const pick =
      pickChannelFrom(channels, allowed.filter((key) => key === String(step.channel)), talker as never) ??
      pickChannelFrom(channels, allowed, talker as never);
    if (!pick) {
      summary.skipped.push({ goalInstanceId, reason: skipReason(talker as never, channels) });
      continue;
    }
    if (pick.assigned) assignments.push({ personId: String(person._id), channelId: pick.channelId });
    if (String(instance.channelId ?? "") !== pick.channelId) {
      instanceMailboxes.push({ goalInstanceId, channelId: pick.channelId });
    }

    const frameStep = rolling && String(step.templateKey ?? "") === frameKeyOf(goal);
    const swapToFixed = rolling && frameStep && composeLate && perLeadFamily;
    if (rolling && frameStep && !swapToFixed) {
      // A frame with nothing written in it is not a message. Wait for the session instead.
      summary.skipped.push({ goalInstanceId, reason: "waiting for Claude to write this touch" });
      continue;
    }
    if (fallback || swapToFixed) summary.fallbacks++;

    toInsert.push({
      _id: new ObjectId(),
      orgId,
      productId,
      goalInstanceId,
      personId: String(person._id),
      ...(fallback ? {} : { planStepId: step.id }),
      ...(fallback || swapToFixed ? { templateKey: String(perLeadFamily) } : {}),
      channel: pick.key,
      channelId: pick.channelId,
      angle: String(swapToFixed ? perLeadFamily : step.angle ?? "follow_up"),
      rationale: swapToFixed
        ? `Nothing was written for step ${step.id} in time, so an email they have not had went in its place.`
        : String(step.why ?? `Plan step ${step.id}; ${pick.reason}.`),
      // No template id and no composed copy. The ladder rung is chosen at send time from how
      // far through the sequence this person is, and its own fallback text is the message —
      // which is what tier 2 means.
      status: "queued",
      dueAt,
      cost: 0,
      signals: [],
      next: {},
      content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
      assetIds: [],
      idempotencyKey: fallback ? `${goalInstanceId}:fallback:${now.getTime()}` : `${goalInstanceId}:step:${step.id}`,
    });
  }

  // Before the actions, so an insert that fails partway still leaves every person pointing
  // at the mailbox their queued row names.
  await persistAssignments(assignments);
  await persistInstanceMailboxes(instanceMailboxes);

  if (advancedIds.length) {
    await db
      .collection(C.goalInstances)
      .updateMany({ _id: { $in: advancedIds } }, { $set: { lastAdvancedAt: now } });
  }

  if (toInsert.length) {
    try {
      const result = await db.collection(C.actions).insertMany(toInsert, { ordered: false });
      summary.queued += result.insertedCount;
    } catch (err) {
      // Duplicate keys are the unique index doing its job: a session wrote the same step
      // between the read above and this insert. Theirs wins; it has words in it.
      const inserted = insertedDespiteDuplicates(err);
      if (inserted === null) throw err;
      summary.queued += inserted;
    }
  }

  if (handOver.length) await enqueueMany(orgId, "compose", handOver, now);
  if (planAsks.length) {
    await enqueueMany(orgId, "plan", planAsks, now);
    await db.collection(C.goalInstances).updateMany({ _id: { $in: askedIds } }, { $set: { checkpointAskedAt: now } });
  }

  return summary;
}

/** A duplicate key is the unique index doing its job. Anything else is a real failure. */
function insertedDespiteDuplicates(err: unknown): number | null {
  const bulk = err as { result?: { insertedCount?: number }; writeErrors?: { code?: number }[] };
  const writeErrors = bulk?.writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.some((e) => e.code !== 11000)) return null;
  return bulk.result?.insertedCount ?? 0;
}
