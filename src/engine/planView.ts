import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { gateOpen, nextStep, type StepEngagement } from "./advance.js";

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
  angle: string | null;
  gate: string | null;
  after_days: number;
  state: StepState;
  /** True for a step whose template is a family of variants: the engine sends the next variant itself. */
  engine_renders: boolean;
  why: string | null;
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
  note: string;
}

export function engagementFrom(actions: Document[], band: string | undefined): StepEngagement {
  return {
    opened: actions.some((a) => Boolean(a.firstOpenedAt)),
    clicked: actions.some((a) => Boolean(a.firstClickedAt)),
    band,
  } as StepEngagement;
}

/** Template families with variants on this product. A step naming one is the engine's to render. */
export async function familyKeysFor(orgId: string, productId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .collection(C.templates)
    .find({ orgId, productId, status: "active", family: { $exists: true, $ne: null } })
    .project({ family: 1 })
    .toArray();
  return new Set(rows.map((t) => String(t.family)).filter(Boolean));
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
  const families = await familyKeysFor(orgId, productId);

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
  const next = nextStep(plan, written, delivered, engagement);
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
        angle: st.angle ? String(st.angle) : null,
        gate: st.gate ? String(st.gate) : null,
        after_days: Number(st.offsetDays ?? st.after_days ?? st.afterDays ?? 0),
        state,
        engine_renders: typeof key === "string" && families.has(key),
        why: st.why ? String(st.why) : null,
      };
    })
    .sort((a, b) => a.step_id - b.step_id);

  const nextView = nextId === null ? null : steps.find((s) => s.step_id === nextId) ?? null;
  let note: string;
  let toWrite: PlanStepView | null = null;
  if (waiting > 0) {
    note = `A message is already waiting for this person. Write nothing until it has gone out.`;
  } else if (!nextView) {
    note = `The plan is exhausted for this person: every remaining step is written or its gate is closed.`;
  } else if (nextView.engine_renders) {
    note = `Step ${nextView.step_id} is the engine's: it sends the next "${nextView.template_key}" variant itself on its own schedule. Nothing to write until that has gone out.`;
  } else {
    toWrite = nextView;
    note = `Write step ${nextView.step_id} (${nextView.template_key ?? nextView.angle ?? "no template"}). Later steps are for later runs.`;
  }

  return {
    plan_id: String(plan._id),
    version: plan.version != null ? Number(plan.version) : null,
    segment: plan.segmentKey ? String(plan.segmentKey) : null,
    steps,
    next_step_to_write: toWrite,
    waiting,
    note,
  };
}
