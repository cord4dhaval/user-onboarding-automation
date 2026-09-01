import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { McpClient } from "../mcp/client.js";
import { resolveSecret } from "../crypto/broker.js";

/**
 * Finds out whether a person has actually done what a campaign is driving them toward.
 *
 * Deterministic on purpose: Claude writes the checks once, when the campaign is created,
 * and the engine runs them forever without a model. What Claude decides is *how* to find
 * out; whether it happened is arithmetic.
 */

export interface CheckDef {
  key: string;
  describedAs: string;
  connectionId: string;
  tool: string;
  args: Record<string, string>;
  assert: string;
  latch?: boolean;
}

export interface VerifySummary {
  examined: number;
  succeeded: number;
  failed: number;
  unchanged: number;
  skipped: Array<{ campaign: string; reason: string }>;
}

/** Resolves "$person.email" style references against the person being checked. */
function resolveArgs(args: Record<string, string>, person: Document, since: Date): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(args)) {
    if (!ref.startsWith("$")) {
      out[name] = ref;
      continue;
    }
    if (ref === "$since") {
      out[name] = since.toISOString();
      continue;
    }
    const path = ref.slice(1).split(".");
    let cursor: unknown = { person };
    for (const part of path) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }
    if (cursor !== undefined) out[name] = cursor;
  }
  return out;
}

/**
 * Assertions are a deliberately small language rather than evaluated code — a check
 * definition is data written by a model, and data written by a model must never be
 * executed.
 *
 *   exists            the response contains anything at all
 *   count >= 2        the first array found has at least this many entries
 *   $.plan != trial   a value at a path differs from a literal
 *   $.active == true
 */
export function evaluateAssertion(assertion: string, payload: unknown): boolean | null {
  const text = assertion.trim();
  if (!text) return null;

  if (text === "exists") return payload !== null && payload !== undefined && !isEmpty(payload);

  const countMatch = text.match(/^count\s*(>=|>|==|<=|<)\s*(\d+)$/);
  if (countMatch) {
    const n = firstArray(payload)?.length ?? 0;
    return compare(n, countMatch[1]!, Number(countMatch[2]));
  }

  const pathMatch = text.match(/^(\$[\w.[\]]*)\s*(>=|>|==|!=|<=|<)\s*(.+)$/);
  if (pathMatch) {
    const actual = pluck(payload, pathMatch[1]!);
    const expected = literal(pathMatch[3]!.trim());
    if (typeof actual === "number" && typeof expected === "number") {
      return compare(actual, pathMatch[2]!, expected);
    }
    if (pathMatch[2] === "==") return actual === expected;
    if (pathMatch[2] === "!=") return actual !== expected;
    return null;
  }

  // Anything we cannot read is undetermined, never false — a check we do not understand
  // must not close someone's campaign.
  return null;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case ">=": return a >= b;
    case ">": return a > b;
    case "==": return a === b;
    case "<=": return a <= b;
    case "<": return a < b;
    default: return false;
  }
}

function literal(text: string): unknown {
  const unquoted = text.replace(/^['"]|['"]$/g, "");
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (unquoted !== "" && !Number.isNaN(Number(unquoted))) return Number(unquoted);
  return unquoted;
}

/**
 * A wrapper object around an empty array is empty, whatever its key count says. Search
 * tools return {"results": []} when they find nobody, and reading that as "exists" would
 * mark people as signed up who never were.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const inner = firstArray(value);
    if (inner) return inner.length === 0;
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return value === "" || value === false || value === 0;
}

function firstArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(inner)) return inner;
    }
  }
  return null;
}

function pluck(payload: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cursor: unknown = payload;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Runs one campaign's checks against the product and moves the campaign on if it can.
 *
 * Three rules keep this from producing wrong outcomes:
 *
 *  - A negative check is never failure. Only a spent budget or a passed deadline ends a
 *    campaign unsuccessfully — product data lags, and a lagging probe would otherwise
 *    close campaigns on people who actually converted.
 *  - Success is measured against a baseline taken on entry, so someone who was already a
 *    customer does not count as having just become one.
 *  - A verifier that is unreachable means the check is skipped, never failed.
 */
export async function verifyCampaign(orgId: string, goalInstanceId: string): Promise<"succeeded" | "failed" | "unchanged" | "skipped"> {
  const db = await getDb();
  const instance = await db.collection(C.goalInstances).findOne({ _id: new ObjectId(goalInstanceId), orgId });
  if (!instance || instance.status !== "active") return "unchanged";

  const goal = await db
    .collection(C.goals)
    .findOne({ orgId, productId: instance.productId, key: instance.goalKey });
  const checks = (goal?.checks ?? []) as CheckDef[];
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) });
  if (!person) return "unchanged";

  const results = { ...((instance.checkResults ?? {}) as Record<string, boolean>) };
  const probes: Record<string, unknown> = {};
  const since = new Date(String(instance.startedAt));
  let ranAny = false;

  for (const check of checks) {
    // A settled fact is not re-asked. Account created once is created forever.
    if (results[check.key] === true && check.latch !== false) continue;

    try {
      const connection = await db
        .collection(C.connections)
        .findOne({ _id: new ObjectId(check.connectionId), orgId });
      if (!connection?.serverUrl) continue;

      const token = await resolveSecret(orgId, check.connectionId, "engine.verify");
      const client = new McpClient(String(connection.serverUrl), token);
      const payload = await client.callTool(check.tool, resolveArgs(check.args, person, since));

      const passed = evaluateAssertion(check.assert, payload);
      ranAny = true;

      // The raw response is kept whatever the reading, because Claude decides the verdict
      // from what the tool actually returned rather than from our interpretation of it.
      probes[check.key] = {
        tool: check.tool,
        at: new Date(),
        engineReading: passed,
        // Trimmed: a probe is evidence, not an archive, and some tools return a lot.
        response: JSON.parse(JSON.stringify(payload ?? null)),
      };

      if (passed === null) {
        // Ambiguous. Recorded so a person or Claude can look, never guessed either way.
        await db.collection(C.events).insertOne({
          _id: new ObjectId(),
          orgId,
          productId: String(instance.productId),
          personId: String(instance.personId),
          source: "system",
          type: "check_undetermined",
          payload: { check: check.key, assert: check.assert },
          ts: new Date(),
        });
        continue;
      }

      if (passed && results[check.key] !== true) {
        results[check.key] = true;
        await db.collection(C.events).insertOne({
          _id: new ObjectId(),
          orgId,
          productId: String(instance.productId),
          personId: String(instance.personId),
          source: "product",
          type: `check_passed:${check.key}`,
          payload: { describedAs: check.describedAs },
          ts: new Date(),
        });
      } else if (!passed) {
        results[check.key] = false;
      }
    } catch {
      // Unreachable verifier: skip, do not fail. A degraded connection must never end
      // someone's campaign.
      continue;
    }
  }

  const allPassed = checks.length > 0 && checks.every((c) => results[c.key] === true);
  const now = new Date();

  if (allPassed) {
    await db.collection(C.goalInstances).updateOne(
      { _id: instance._id },
      {
        $set: {
          status: "succeeded",
          checkResults: results,
          probeResults: probes,
          endedAt: now,
          outcome: "verified by the engine",
        },
      },
    );
    // Congratulating someone and then chasing them twice is the obvious failure here.
    await db.collection(C.actions).updateMany(
      { orgId, goalInstanceId, status: { $in: ["queued", "awaiting_approval"] } },
      { $set: { status: "skipped", skipReason: "campaign already succeeded" } },
    );
    await db
      .collection(C.people)
      .updateOne({ _id: person._id }, { $set: { lifecycle: "cooling", lastSignalAt: now } });
    return "succeeded";
  }

  const deadlinePassed = new Date(String(instance.deadline)) < now;
  const budget = goal?.budget as { touches: number } | undefined;
  const spent = (instance.spent as { touches: number } | undefined)?.touches ?? 0;
  const budgetSpent = Boolean(budget && spent >= budget.touches);

  if (deadlinePassed || budgetSpent) {
    await db.collection(C.goalInstances).updateOne(
      { _id: instance._id },
      {
        $set: {
          status: "failed",
          checkResults: results,
          probeResults: probes,
          endedAt: now,
          outcome: deadlinePassed ? "deadline passed" : "budget spent",
        },
      },
    );
    await db.collection(C.actions).updateMany(
      { orgId, goalInstanceId, status: { $in: ["queued", "awaiting_approval"] } },
      { $set: { status: "skipped", skipReason: "campaign ended" } },
    );
    // They stay in the library with their whole history, and may be approached again once
    // the cooling period passes.
    await db.collection(C.people).updateOne(
      { _id: person._id },
      { $set: { lifecycle: "cooling", coolingUntil: new Date(now.getTime() + 90 * 86_400_000) } },
    );
    return "failed";
  }

  // A campaign that is still running gets its next look scheduled by tier. An unreachable
  // verifier backs off rather than retrying in a tight loop.
  const interval = ranAny
    ? verifyIntervalMs(person, instance.lastContactedAt as Date | undefined)
    : 30 * 60_000;

  await db.collection(C.goalInstances).updateOne(
    { _id: instance._id },
    {
      $set: {
        checkResults: results,
        probeResults: probes,
        lastVerifiedAt: now,
        nextVerifyAt: new Date(now.getTime() + interval),
        verifyIntervalMinutes: Math.round(interval / 60_000),
      },
    },
  );
  return ranAny ? "unchanged" : "skipped";
}

/**
 * How often one person's checks are worth re-running.
 *
 * Someone contacted in the last two days and running hot is the most likely to have just
 * converted, and noticing late means congratulating them after chasing them again. Someone
 * cold and silent has nothing happening, and asking hourly only spends a rate limit.
 */
export function verifyIntervalMs(person: Document | null, lastContactedAt?: Date): number {
  const HOUR = 3_600_000;
  const band = (person?.temp as { band?: string } | undefined)?.band;
  const contactedRecently = lastContactedAt
    ? Date.now() - new Date(lastContactedAt).getTime() < 48 * HOUR
    : false;

  if (band === "hot" && contactedRecently) return HOUR;
  if (band === "cold" || band === "dead") return 24 * HOUR;
  return 6 * HOUR;
}

/** Verifies every active campaign whose interval has elapsed. */
export async function verifyDue(orgId: string, productId: string, limit = 50): Promise<VerifySummary> {
  const db = await getDb();
  const summary: VerifySummary = { examined: 0, succeeded: 0, failed: 0, unchanged: 0, skipped: [] };

  const now = new Date();
  // Only what is actually due. Re-checking everyone on every tick spends a provider's rate
  // limit on questions whose answers cannot have changed.
  const due = await db
    .collection(C.goalInstances)
    .find({
      orgId,
      productId,
      status: "active",
      $or: [{ nextVerifyAt: { $lte: now } }, { nextVerifyAt: { $exists: false } }],
    })
    .sort({ nextVerifyAt: 1 })
    .limit(limit)
    .toArray();

  for (const instance of due) {
    summary.examined++;
    const outcome = await verifyCampaign(orgId, String(instance._id));
    if (outcome === "succeeded") summary.succeeded++;
    else if (outcome === "failed") summary.failed++;
    else if (outcome === "skipped") summary.skipped.push({ campaign: String(instance._id), reason: "no verifier reachable" });
    else summary.unchanged++;
  }

  return summary;
}
