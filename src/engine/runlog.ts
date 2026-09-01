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
export const ROUTINE_KEYS = ["monitor", "plan", "compose"] as const;
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
    case "sweep": {
      const packets = Array.isArray(result) ? result : [];
      for (const p of packets as Document[]) out.work_items = (out.work_items ?? 0) + int(p.total_work_items);
      break;
    }
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
      out.checks_set = Array.isArray(r.checks) ? (r.checks as unknown[]).length : 1;
      break;
    case "verify_person":
      out.probed = 1;
      break;
    case "approve":
      out[args.decision === "reject" ? "rejected" : "approved"] = int(r.updated);
      break;
    case "poll_sources":
      out.leads_ingested = int(r.ingested);
      break;
    case "fire_due":
      out.sent = int(r.sent ?? r.claimed);
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
  sent: ["sent", "sent"],
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
 * A scoped sweep always starts a fresh one — that is the routine announcing itself. Every
 * other call joins whatever is still open for the same token, and opens an ad-hoc run if
 * nothing is, so no call is ever orphaned.
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

  if (tool === "sweep" && isRoutineKey(args.scope)) {
    await closeRun(orgId, userId, at);
    return { runId: await openRun({ orgId, userId, productId: argProductId, kind: args.scope, at }), productId: argProductId };
  }

  const open = await db
    .collection(C.routineRuns)
    .findOne(
      { orgId, userId, status: "running", lastCallAt: { $gte: new Date(at.getTime() - IDLE_CLOSE_MS) } },
      { sort: { lastCallAt: -1 } },
    );

  if (open) {
    const productId = String(open.productId ?? "") || argProductId;
    // A run that opened before its product was known adopts the first one it sees.
    if (!open.productId && argProductId) {
      await db.collection(C.routineRuns).updateOne({ _id: open._id }, { $set: { productId: argProductId } });
    }
    return { runId: open._id as ObjectId, productId };
  }

  return {
    runId: await openRun({ orgId, userId, productId: argProductId, kind: "ad-hoc", at }),
    productId: argProductId,
  };
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

/** Closes whatever run this token has open. Called when a new one starts. */
async function closeRun(orgId: string, userId: string, at: Date): Promise<void> {
  const db = await getDb();
  const open = await db
    .collection(C.routineRuns)
    .findOne({ orgId, userId, status: "running" }, { sort: { lastCallAt: -1 } });
  if (!open) return;
  await finish(open, at);
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
  return {
    id: String(run._id),
    routine: String(run.routine) as RunKind,
    status: String(run.status) as RunStatus,
    startedAt: new Date(String(run.startedAt)).toISOString(),
    endedAt: run.endedAt ? new Date(String(run.endedAt)).toISOString() : null,
    ms: int(run.ms),
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
