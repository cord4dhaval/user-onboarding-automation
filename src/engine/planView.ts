import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { gateOpen, nextStep, type StepEngagement } from "./advance.js";
import { engineRenderedKeysFor, skeletonFor, writtenTemplatesFor, type Skeleton } from "./engineSteps.js";
import { newsSincePlan } from "./news.js";
import { FRAME_BODY_MAX_WORDS, frameKeyOf, isRolling, isRollingPlan } from "./rolling.js";

/**
 * One person's plan as a session should read it: every step with where it stands, and
 * the single step that is theirs to write next, decided by the same rules the engine
 * uses when it advances the campaign — the steps already written, the angles already
 * delivered, the gates against what the person did, and which steps are the engine's own.
 *
 * Before this the card carried no plan at all. A session composing the next message had
 * to guess a step id, and a guess that landed on a gated step or on a welcome variant
 * would have been accepted and sent: a "privacy" message inside the onboarding frame, or
 * freehand copy in the slot of a first mail that is meant to be tested as written.
 */
export type StepState = "sent" | "waiting" | "skipped" | "open" | "closed";

export interface PlanStepView {
  step_id: number;
  template_key: string | null;
  channel: string;
  angle: string | null;
  gate: string | null;
  after_days: number;
  state: StepState;
  /** True when the engine renders this step itself: a family of variants, or a template with no slot. */
  engine_renders: boolean;
  engine_reason: string | null;
  why: string | null;
  /** Only on next_step_to_write: the template the words land in. */
  skeleton?: Skeleton | null;
}

export interface PlanView {
  plan_id: string;
  version: number | null;
  segment: string | null;
  steps: PlanStepView[];
  /** The step a session should compose now, or null when there is nothing to write. */
  next_step_to_write: PlanStepView | null;
  /** Messages already queued, awaiting approval or sending for this campaign. */
  waiting: number;
  /** When news this plan was written without reached us. Present only then: the plan is stale. */
  news_since_plan?: string;
  note: string;
}

export function engagementFrom(actions: Document[], band: string | undefined): StepEngagement {
  return {
    opened: actions.some((a) => Boolean(a.firstOpenedAt)),
    clicked: actions.some((a) => Boolean(a.firstClickedAt)),
    band,
  } as StepEngagement;
}

const WRITTEN_AND_LIVE = ["queued", "awaiting_approval", "sending", "sent", "dispatched"];
const WAITING = ["queued", "awaiting_approval", "sending"];

/**
 * @param instance the goal instance
 * @param actions every action on that goal instance, any status
 * @param band the person's temperature band, for warm/cold gates
 */
export async function planViewFor(instance: Document, actions: Document[], band: string | undefined): Promise<PlanView | null> {
  if (!instance.currentPlanId || !ObjectId.isValid(String(instance.currentPlanId))) return null;
  const db = await getDb();
  const plan = await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) });
  if (!plan) return null;

  const orgId = String(instance.orgId);
  const productId = String(instance.productId);
  const engineOwned = await engineRenderedKeysFor(orgId, productId);
  const goal = await db.collection(C.goals).findOne({ orgId, productId, key: String(instance.goalKey ?? "") }, { projection: { perLeadPlan: 1 } });
  const rolling = isRolling(goal);
  const frameKey = frameKeyOf(goal);

  const byStep = new Map<number, Document>();
  const written = new Set<number>();
  const delivered = new Set<string>();
  let waiting = 0;
  for (const a of actions) {
    const id = Number(a.planStepId);
    if (Number.isFinite(id)) {
      written.add(id);
      byStep.set(id, a);
    }
    if (WAITING.includes(String(a.status))) waiting++;
    if (WRITTEN_AND_LIVE.includes(String(a.status))) delivered.add(String(a.angle ?? "").toLowerCase());
  }
  const engagement = engagementFrom(actions, band);
  // News that reached us after this plan was written makes its unwritten steps stale, as
  // advance() reads it: nothing more is written from it, a new plan is.
  const person = rolling && isRollingPlan(plan) && instance.personId && ObjectId.isValid(String(instance.personId))
    ? await db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) }, { projection: { newsAt: 1 } })
    : null;
  const newsAt = newsSincePlan(person, plan.createdAt);
  // In a rolling campaign only a plan written for it runs; an older one is history.
  const next = (rolling && !isRollingPlan(plan)) || newsAt ? null : nextStep(plan, written, delivered, engagement);
  const nextId = next ? Number(next.id) : null;

  const steps: PlanStepView[] = ((plan.steps ?? []) as Document[])
    .map((st) => {
      const id = Number(st.id ?? st.step_id);
      const key = st.templateKey ?? st.template_key;
      const action = byStep.get(id);
      const status = String(action?.status ?? "");
      const state: StepState =
        !action ? (gateOpen(st.gate, engagement) ? "open" : "closed")
        : WAITING.includes(status) ? "waiting"
        : ["sent", "dispatched"].includes(status) ? "sent"
        : "skipped";
      return {
        step_id: id,
        template_key: typeof key === "string" && key ? key : null,
        channel: String(st.channel ?? "email"),
        angle: st.angle ? String(st.angle) : null,
        gate: st.gate ? String(st.gate) : null,
        after_days: Number(st.offsetDays ?? st.after_days ?? st.afterDays ?? 0),
        state,
        engine_renders: typeof key === "string" && engineOwned.has(key),
        engine_reason: typeof key === "string" ? engineOwned.get(key) ?? null : null,
        why: st.why ? String(st.why) : null,
      };
    })
    .sort((a, b) => a.step_id - b.step_id);

  const nextView = nextId === null ? null : steps.find((s) => s.step_id === nextId) ?? null;
  let note: string;
  let toWrite: PlanStepView | null = null;
  if (newsAt) {
    note = `News about this person reached us at ${newsAt.toISOString()}, after this plan was written (see since_last_plan). Its unsent steps are stale: plan again with plan_goal, built on that news, before writing anything.`;
  } else if (waiting > 0) {
    note = `A message is already waiting for this person. Write nothing until it has gone out.`;
  } else if (rolling && !isRollingPlan(plan)) {
    note = `This campaign plans one or two touches at a time, and this plan was written before that. It is spent; the engine asks for this lead's next plan at their checkpoint.`;
  } else if (rolling && !nextView) {
    note = `Every planned touch is written. The engine watches what this lead does with them and asks for the next plan.`;
  } else if (!nextView) {
    note = `The plan is exhausted for this person: every remaining step is written or its gate is closed.`;
  } else if (nextView.engine_renders) {
    note = `Step ${nextView.step_id} is the engine's: ${nextView.engine_reason ?? "it renders it itself"} ("${nextView.template_key}"). Nothing to write until that has gone out.`;
  } else {
    // On a channel where every message is an approved template with the writer's words in
    // it, a step naming none of them (or a key that does not exist) is still written: the
    // skeleton shown is the channel's first such template, with the others as choices.
    const written = await writtenTemplatesFor(orgId, productId);
    const stepKey = nextView.template_key ?? "";
    const skeletonKey =
      written.channels.has(nextView.channel) && !written.activeKeys.has(stepKey)
        ? [...written.byKey.values()].find((t) => String(t.channel) === nextView.channel)?.key
        : stepKey;
    const skeleton = skeletonKey ? await skeletonFor(orgId, productId, String(skeletonKey), plan.segmentKey ? String(plan.segmentKey) : null) : null;
    toWrite = { ...nextView, skeleton };
    note = rolling && nextView.template_key === frameKey
      ? `Write step ${nextView.step_id} whole, short (about 50 words), in parts: subject, opening, scene, reveal, limit (only if most of their work is away from a computer), question (the price on a link ask), ps (reply \"call\"), format with format_why, ask, theme and hook. The frame lays the parts out for plain text or HTML and adds the greeting, the button (left off for a reply ask), the sign-off and the unsubscribe line. Read writing on the lead card first.`
      : `Write step ${nextView.step_id} (${nextView.template_key ?? nextView.angle ?? "no template"}), and only the your_words part of its skeleton. Later steps are for later runs.`;
  }

  return {
    plan_id: String(plan._id),
    version: plan.version != null ? Number(plan.version) : null,
    segment: plan.segmentKey ? String(plan.segmentKey) : null,
    steps,
    next_step_to_write: toWrite,
    waiting,
    ...(newsAt ? { news_since_plan: newsAt.toISOString() } : {}),
    note,
  };
}
