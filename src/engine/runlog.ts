import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * The record of what a routine actually did.
 *
 * A routine does not run here — it runs in Claude's scheduler and reaches us as a series
 * of loose tool calls over HTTP. There is no run id in that, so one is derived: every
 * routine prompt opens with `sweep` and a scope, and that scope is the routine's identity.
 * A sweep opens a run; every later call from the same token joins it; a gap closes it.
 *
 * Two things are stored, deliberately. Counters answer "what did the 14:05 Monitor run
 * achieve" at a glance, and the raw calls answer "why did it decide that" when the
 * counters look wrong. The first is read daily, the second twice a year, so they have
 * different lifetimes rather than the same one.
 */

/** The scopes a routine sweeps with. Anything else is a person poking at the tools by hand. */
export const ROUTINE_KEYS = ["acquire", "advance", "react", "close", "maintain"] as const;

/**
 * The four product-scoped routines this system started with, kept so run history written
 * under them still reads. Nothing schedules them any more: they were replaced by five
 * org-scoped mains when it became clear that a routine per product meant forty scheduled
 * sessions for ten products, and that each of them was choosing its own work by sweeping
 * the database in disk order.
 */
export const LEGACY_ROUTINE_KEYS = ["monitor", "plan", "compose", "groom"] as const;
export type RoutineKey = (typeof ROUTINE_KEYS)[number];
/** `engine` is the model-free tick; `ad-hoc` is a human or an unscoped session. */
export type RunKind = RoutineKey | "engine" | "ad-hoc";

export type RunStatus = "running" | "ok" | "error" | "stalled";

/** A session that has gone quiet this long has ended. Claude's calls come seconds apart. */
const IDLE_CLOSE_MS = 5 * 60_000;
/** Past this with no end, the session did not finish — it died mid-run. */
const STALLED_MS = 30 * 60_000;
/** A composed email body is worth keeping; a whole batch of them is not worth keeping forever. */
const PAYLOAD_LIMIT = 4_000;

export interface RunCounters {
  [counter: string]: number;
}

function isRoutineKey(value: unknown): value is RoutineKey {
  return typeof value === "string" && (ROUTINE_KEYS as readonly string[]).includes(value);
}

/** Accepts historical keys too, so a run log written last week still renders. */
export function isKnownRoutine(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [...(ROUTINE_KEYS as readonly string[]), ...(LEGACY_ROUTINE_KEYS as readonly string[])].includes(value)
  );
}

/** Stored as text, capped. A truncated payload still shows the shape of what happened. */
function payload(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > PAYLOAD_LIMIT ? `${text.slice(0, PAYLOAD_LIMIT)}… [${text.length} chars]` : text;
}

const int = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * What one tool call achieved, in engine words rather than JSON-RPC ones.
 *
 * Nobody reads "compose_batch returned {queued: 4}". Everybody reads "4 messages written".
 */
export function rollup(tool: string, args: Document, result: unknown): RunCounters {
  const out: RunCounters = {};
  const r = (result ?? {}) as Document;

  switch (tool) {
    case "sweep":
      out.work_items = int(r.total_work_items);
      break;
    case "classify":
      out.classified = int(r.updated);
      break;
    case "plan_goal":
      out.planned = 1;
      out.plan_steps = int(r.steps);
      break;
    case "compose_batch":
      out.composed = int(r.queued);
      break;
    case "mark_state": {
      const verdicts = Array.isArray(r.verdicts) ? (r.verdicts as Document[]) : [];
      for (const v of verdicts) {
        if (v.state === "succeeded") out.succeeded = (out.succeeded ?? 0) + 1;
        else if (v.state === "failed") out.failed = (out.failed ?? 0) + 1;
        else out.continued = (out.continued ?? 0) + 1;
      }
      break;
    }
    case "resolve_check":
      out.checks_resolved = 1;
      break;
    case "set_checks":
      out.checks_set = int(r.checks);
      break;
    case "verify_person":
      out.probed = 1;
      break;
    case "approve":
      out[args.decision === "reject" ? "rejected" : "approved"] = int(r.updated);
      break;
    case "poll_sources": {
      // One result per source, each an ingest summary.
      const results = Array.isArray(r.results) ? (r.results as Document[]) : [];
      for (const one of results) {
        out.leads_ingested = (out.leads_ingested ?? 0) + int(one.created) + int(one.attachedToExisting);
        out.first_touches = (out.first_touches ?? 0) + int(one.firstTouchesQueued);
      }
      break;
    }
    case "fire_due":
      out.sent = int(r.sent);
      out.reconciled = int((r.reconciled as Document | undefined)?.checked);
      break;
    case "lead_card":
      out.read = 1;
      break;
    default:
      break;
  }

  return out;
}

const COUNTER_LABELS: Record<string, [string, string]> = {
  work_items: ["work item", "work items"],
  read: ["card read", "cards read"],
  classified: ["person classified", "people classified"],
  planned: ["plan written", "plans written"],
  plan_steps: ["step", "steps"],
  composed: ["message written", "messages written"],
  succeeded: ["succeeded", "succeeded"],
  failed: ["failed", "failed"],
  continued: ["still running", "still running"],
  checks_resolved: ["check resolved", "checks resolved"],
  checks_set: ["check set", "checks set"],
  probed: ["person probed", "people probed"],
  approved: ["approved", "approved"],
  rejected: ["rejected", "rejected"],
  leads_ingested: ["lead in", "leads in"],
  first_touches: ["first touch queued", "first touches queued"],
  sent: ["sent", "sent"],
  held: ["held for review", "held for review"],
  deferred: ["deferred to a civil hour", "deferred to a civil hour"],
  reconciled: ["reconciled", "reconciled"],
};

/** Counters in the words a person would use. "4 messages written", not "composed: 4". */
export function describeCounters(counters: RunCounters): string {
  const parts = Object.entries(counters)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => {
      const label = COUNTER_LABELS[key];
      if (!label) return `${value} ${key.replace(/_/g, " ")}`;
      return `${value} ${value === 1 ? label[0] : label[1]}`;
    });
  return parts.join(" · ");
}

/** Sums counters from several runs, for a day's or a routine's total. */
export function sumCounters(runs: Array<{ counters?: RunCounters }>): RunCounters {
  const total: RunCounters = {};
  for (const run of runs) {
    for (const [key, value] of Object.entries(run.counters ?? {})) total[key] = (total[key] ?? 0) + value;
  }
  return total;
}

interface OpenRunInput {
  orgId: string;
  userId: string;
  productId: string;
  kind: RunKind;
  at: Date;
}

async function openRun(input: OpenRunInput): Promise<ObjectId> {
  const db = await getDb();
  const runId = new ObjectId();
  await db.collection(C.routineRuns).insertOne({
    _id: runId,
    orgId: input.orgId,
    productId: input.productId,
    userId: input.userId,
    routine: input.kind,
    status: "running" satisfies RunStatus,
    startedAt: input.at,
    lastCallAt: input.at,
    endedAt: null,
    ms: 0,
    calls: 0,
    errors: 0,
    counters: {},
    firstError: null,
  });
  return runId;
}

/**
 * Which run this call belongs to.
 *
 * A routine announces itself twice — `register_routine` names it, and the opening `sweep`
 * names it again as a scope. Either is enough to start a run, and the second one joins the
 * run the first started rather than splitting one session into two. Every other call joins
 * whatever is still open for the same token, and opens an ad-hoc run if nothing is, so no
 * call is ever orphaned.
 */
async function resolveRun(
  orgId: string,
  userId: string,
  tool: string,
  args: Document,
  at: Date,
): Promise<{ runId: ObjectId; productId: string }> {
  const db = await getDb();
  const argProductId = typeof args.product_id === "string" ? args.product_id : "";

  const declared =
    tool === "register_routine" ? args.routine : tool === "sweep" ? args.scope : undefined;

  const open = await db
    .collection(C.routineRuns)
    .findOne(
      { orgId, userId, status: "running", lastCallAt: { $gte: new Date(at.getTime() - IDLE_CLOSE_MS) } },
      { sort: { lastCallAt: -1 } },
    );

  if (isRoutineKey(declared)) {
    // Already inside this routine's own run — the second announcement, not a new session.
    if (open && open.routine === declared) return adopt(open, argProductId);

    // A routine that called something before announcing itself opened an undeclared run a
    // few seconds ago. That was this run all along, so it is relabelled rather than left
    // beside the real one as a phantom "by hand" row.
    if (open && open.routine === "ad-hoc") {
      await db.collection(C.routineRuns).updateOne({ _id: open._id }, { $set: { routine: declared } });
      return adopt(open, argProductId);
    }

    if (open) await finish(open, at);
    return {
      runId: await openRun({ orgId, userId, productId: argProductId, kind: declared, at }),
      productId: argProductId,
    };
  }

  if (open) return adopt(open, argProductId);

  return {
    runId: await openRun({ orgId, userId, productId: argProductId, kind: "ad-hoc", at }),
    productId: argProductId,
  };
}

/** A run that opened before its product was known adopts the first one it sees. */
async function adopt(run: Document, argProductId: string): Promise<{ runId: ObjectId; productId: string }> {
  const productId = String(run.productId ?? "") || argProductId;
  if (!run.productId && argProductId) {
    const db = await getDb();
    await db.collection(C.routineRuns).updateOne({ _id: run._id }, { $set: { productId: argProductId } });
  }
  return { runId: run._id as ObjectId, productId };
}

/**
 * What each routine is allowed to touch.
 *
 * Prompt text was not enough: a Compose run whose prompt said "if there is nothing to do,
 * stop" instead went and did the Plan routine's whole job — classifying people and writing
 * pipelines. Harmless once; at scale it means Compose spends its budget planning and the
 * messages actually due that day never get written.
 *
 * So the boundary is enforced where it can be, rather than asked for. Tools listed for more
 * than one routine really are shared: Monitor replans someone who has gone off-plan, and
 * repairs a campaign whose checks are bound to the wrong tool.
 */
const ALWAYS_ALLOWED = [
  "register_routine",
  "routine_status",
  "sweep",
  "lead_card",
  "report",
  "list_products",
  // Every main claims its own slice and hands it back, and every main should be able to say
  // what it could not get to.
  "next_work",
  "finish_work",
  "backlog_report",
];

const ROUTINE_TOOLS: Record<RoutineKey, string[]> = {
  // Acquire reads new arrivals and writes the sequence their segment runs. It may write a
  // playbook — the sequence for a whole segment — but never a per-person plan: a person
  // nobody has engaged with has given no evidence that would justify one.
  acquire: [...ALWAYS_ALLOWED, "classify", "save_enrichment", "upsert_playbook", "what_works", "verifiers", "set_checks"],
  // Advance writes the messages for people the engine judged worth writing for.
  advance: [...ALWAYS_ALLOWED, "compose_batch", "preview_template", "get_brand"],
  // React is the only routine that rewrites one person's plan, because it is the only one
  // that ever sees evidence about one person: a click, a reply, a bounce.
  react: [...ALWAYS_ALLOWED, "plan_goal", "compose_batch", "record_reply", "what_works", "upsert_playbook"],
  // Close decides whether someone is done, and repairs the checks that decide it.
  close: [...ALWAYS_ALLOWED, "mark_state", "resolve_check", "verify_person", "verifiers", "set_checks", "record_reply"],
  // Maintain finishes setup, and raises the one notification for what only a human can give.
  maintain: [...ALWAYS_ALLOWED, "setup_gaps", "notify_owner", "get_brand", "upsert_template", "preview_template", "draft_campaign", "upsert_playbook", "what_works"],
};

/** Which routine, if any, the caller is currently running as. Ad-hoc sessions return null. */
export async function currentRoutine(orgId: string, userId: string): Promise<RoutineKey | null> {
  const db = await getDb();
  const open = await db
    .collection(C.routineRuns)
    .findOne(
      { orgId, userId, status: "running", lastCallAt: { $gte: new Date(Date.now() - IDLE_CLOSE_MS) } },
      { sort: { lastCallAt: -1 }, projection: { routine: 1 } },
    );
  const routine = open ? String(open.routine) : "";
  return isRoutineKey(routine) ? routine : null;
}

/**
 * Refuses a tool that belongs to a different routine. Returns the reason, or null to allow.
 * A person driving the tools by hand is never restricted — only a declared routine is.
 */
export async function refuseOutOfScope(orgId: string, userId: string, tool: string): Promise<string | null> {
  const routine = await currentRoutine(orgId, userId);
  if (!routine) return null;
  if (ROUTINE_TOOLS[routine].includes(tool)) return null;

  const owners = ROUTINE_KEYS.filter((key) => ROUTINE_TOOLS[key].includes(tool));
  return (
    `${tool} is not part of the ${routine} routine${owners.length ? ` — it belongs to ${owners.join(" and ")}` : ""}. ` +
    `Stop and do only the steps in your own prompt. If you believe you should be calling this, the prompt saved ` +
    `in this routine is probably the wrong one: check it against the Routines page.`
  );
}

export interface ToolCallRecord {
  orgId: string;
  userId: string;
  tool: string;
  args: Document;
  result?: unknown;
  error?: string;
  ms: number;
  at?: Date;
}

/**
 * Records one tool call against its run and folds its outcome into the run's counters.
 *
 * Never throws. A logging failure must not turn a working tool call into an error the
 * routine has to reason about.
 */
export async function recordToolCall(record: ToolCallRecord): Promise<void> {
  try {
    const db = await getDb();
    const at = record.at ?? new Date();
    const { runId, productId } = await resolveRun(record.orgId, record.userId, record.tool, record.args, at);

    await db.collection(C.routineCalls).insertOne({
      _id: new ObjectId(),
      runId,
      orgId: record.orgId,
      productId,
      tool: record.tool,
      args: payload(record.args) ?? null,
      result: record.error ? null : (payload(record.result) ?? null),
      error: record.error ?? null,
      ms: record.ms,
      ts: at,
    });

    const counters = record.error ? {} : rollup(record.tool, record.args, record.result);
    const inc: Document = { calls: 1, errors: record.error ? 1 : 0 };
    for (const [key, value] of Object.entries(counters)) inc[`counters.${key}`] = value;

    await db.collection(C.routineRuns).updateOne(
      { _id: runId },
      { $inc: inc, $set: { lastCallAt: at } },
    );

    if (record.error) {
      await db
        .collection(C.routineRuns)
        .updateOne({ _id: runId, firstError: null }, { $set: { firstError: `${record.tool}: ${record.error}` } });
    }
  } catch {
    // Deliberately silent.
  }
}

async function finish(run: Document, now: Date): Promise<void> {
  const db = await getDb();
  const startedAt = new Date(String(run.startedAt));
  const lastCallAt = new Date(String(run.lastCallAt ?? run.startedAt));
  const stalled = now.getTime() - lastCallAt.getTime() > STALLED_MS;
  const status: RunStatus = stalled ? "stalled" : int(run.errors) > 0 ? "error" : "ok";

  await db.collection(C.routineRuns).updateOne(
    { _id: run._id },
    { $set: { status, endedAt: lastCallAt, ms: lastCallAt.getTime() - startedAt.getTime() } },
  );
}

/**
 * Ends runs whose session has gone quiet. Runs on the tick, so a finished routine stops
 * saying "running" within a minute or two of its last call.
 */
export async function closeIdleRuns(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const idle = await db
    .collection(C.routineRuns)
    .find({ status: "running", lastCallAt: { $lt: new Date(now.getTime() - IDLE_CLOSE_MS) } })
    .limit(200)
    .toArray();

  for (const run of idle) await finish(run, now);
  return idle.length;
}

/** Writes the engine's own tick as a run, so the clock and the routines share one log. */
export async function recordEngineRun(input: {
  orgId: string;
  productId: string;
  counters: RunCounters;
  report: unknown;
  startedAt: Date;
  error?: string;
}): Promise<void> {
  try {
    const db = await getDb();
    const endedAt = new Date();
    const runId = new ObjectId();
    await db.collection(C.routineRuns).insertOne({
      _id: runId,
      orgId: input.orgId,
      productId: input.productId,
      userId: "engine",
      routine: "engine" satisfies RunKind,
      status: (input.error ? "error" : "ok") satisfies RunStatus,
      startedAt: input.startedAt,
      lastCallAt: endedAt,
      endedAt,
      ms: endedAt.getTime() - input.startedAt.getTime(),
      calls: 1,
      errors: input.error ? 1 : 0,
      counters: input.counters,
      firstError: input.error ?? null,
    });
    await db.collection(C.routineCalls).insertOne({
      _id: new ObjectId(),
      runId,
      orgId: input.orgId,
      productId: input.productId,
      tool: "tick",
      args: null,
      result: payload(input.report) ?? null,
      error: input.error ?? null,
      ms: endedAt.getTime() - input.startedAt.getTime(),
      ts: endedAt,
    });
  } catch {
    // Deliberately silent.
  }
}

export interface RunRow {
  id: string;
  routine: RunKind;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  ms: number;
  calls: number;
  errors: number;
  counters: RunCounters;
  firstError: string | null;
}

function toRow(run: Document): RunRow {
  const startedAt = new Date(String(run.startedAt));
  const lastCallAt = new Date(String(run.lastCallAt ?? run.startedAt));

  return {
    id: String(run._id),
    routine: String(run.routine) as RunKind,
    status: String(run.status) as RunStatus,
    startedAt: startedAt.toISOString(),
    endedAt: run.endedAt ? new Date(String(run.endedAt)).toISOString() : null,
    // A run still in progress has no stored duration yet, so it is measured from where it
    // has got to — otherwise a session three minutes in reads as "0 ms".
    ms: int(run.ms) || Math.max(0, lastCallAt.getTime() - startedAt.getTime()),
    calls: int(run.calls),
    errors: int(run.errors),
    counters: (run.counters ?? {}) as RunCounters,
    firstError: run.firstError ? String(run.firstError) : null,
  };
}

export async function listRuns(
  orgId: string,
  productId: string,
  options: { routine?: string; limit?: number } = {},
): Promise<RunRow[]> {
  const db = await getDb();
  const filter: Document = { orgId, productId };
  if (options.routine && options.routine !== "all") filter.routine = options.routine;

  const runs = await db
    .collection(C.routineRuns)
    .find(filter)
    .sort({ startedAt: -1 })
    .limit(options.limit ?? 60)
    .toArray();
  return runs.map(toRow);
}

/** The most recent run of each kind, for the cards at the top of the log. */
export async function latestRuns(orgId: string, productId: string): Promise<Partial<Record<RunKind, RunRow>>> {
  const db = await getDb();
  const rows = await db
    .collection(C.routineRuns)
    .aggregate([
      { $match: { orgId, productId } },
      { $sort: { startedAt: -1 } },
      { $group: { _id: "$routine", run: { $first: "$$ROOT" } } },
    ])
    .toArray();

  const out: Partial<Record<RunKind, RunRow>> = {};
  for (const row of rows) out[String(row._id) as RunKind] = toRow(row.run as Document);
  return out;
}

export interface CallRow {
  id: string;
  tool: string;
  args: string | null;
  result: string | null;
  error: string | null;
  ms: number;
  ts: string;
}

export async function listCalls(orgId: string, runId: string): Promise<CallRow[]> {
  const db = await getDb();
  if (!ObjectId.isValid(runId)) return [];
  const calls = await db
    .collection(C.routineCalls)
    .find({ orgId, runId: new ObjectId(runId) })
    .sort({ ts: 1 })
    .limit(500)
    .toArray();

  return calls.map((c) => ({
    id: String(c._id),
    tool: String(c.tool),
    args: c.args ? String(c.args) : null,
    result: c.result ? String(c.result) : null,
    error: c.error ? String(c.error) : null,
    ms: int(c.ms),
    ts: new Date(String(c.ts)).toISOString(),
  }));
}
