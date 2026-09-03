import { ObjectId } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { anglePerformance, anglesTriedOn, attributeReply, bumpPrior, explorationBlock, MIN_SAMPLE, spentAngles, stampGoalOutcome, summarisePriors } from "../../engine/outcomes.js";
import { greetingName } from "../../engine/names.js";
import { suppress } from "../../engine/suppression.js";
import { runSource, dueSources } from "../../engine/runSource.js";
import { fireDue } from "../../engine/fireDue.js";
import { reconcileDispatched } from "../../engine/reconcile.js";
import { resolveChannelAdapter } from "../../engine/adapters.js";
import { registerRoutine, routineHealth } from "../../engine/routines.js";
import { listRuns, sumCounters, ROUTINE_KEYS, type RoutineKey } from "../../engine/runlog.js";

/**
 * The surface a Claude routine drives.
 *
 * Design rule: tools return decision-ready packets, not rows. Context is the scarce
 * resource in a session, so understanding one lead must never cost twelve calls.
 *
 * Nothing here ever returns a credential. Tools see connection ids, provider names and
 * status; the engine resolves secrets in-process at send time.
 */

/** Who is calling. Resolved from their OAuth token, never from the arguments. */
export interface ToolCtx {
  orgId: string;
  userId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Why a "succeeded" verdict cannot be accepted, or null when it can.
 *
 * The tool description has always said to mark success only when the evidence supports it.
 * That was a request, and a request is not a guardrail — a campaign was ended for three
 * people on two checks that were structurally incapable of returning false and a third
 * that never resolved at all.
 *
 * So the rule lives here now, in the same place the budget and suppression rules live:
 * every check the campaign defines must actually have passed. Nothing upstream can
 * reason its way past it.
 */
/**
 * Checks that have passed for everyone they have ever run on.
 *
 * Real success is never unanimous. A check with a perfect record across a meaningful
 * number of people is almost always bound to something org-wide — a tool answering about
 * the caller's own account rather than the person's — and it will keep ending campaigns
 * for people who have done nothing.
 *
 * Three is the floor. Below that a clean run is ordinary luck, and crying wolf about it
 * would teach everyone to ignore this.
 */
async function undiscriminatingChecks(
  orgId: string,
  productId: string,
): Promise<Array<Record<string, unknown>>> {
  const db = await getDb();
  const instances = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, checkResults: { $exists: true } })
    .project({ goalKey: 1, checkResults: 1 })
    .toArray();
  if (instances.length < 3) return [];

  const tally = new Map<string, { goalKey: string; key: string; pass: number; seen: number }>();
  for (const instance of instances) {
    for (const [key, value] of Object.entries((instance.checkResults ?? {}) as Record<string, boolean>)) {
      const id = `${String(instance.goalKey)}::${key}`;
      const row = tally.get(id) ?? { goalKey: String(instance.goalKey), key, pass: 0, seen: 0 };
      row.seen += 1;
      if (value === true) row.pass += 1;
      tally.set(id, row);
    }
  }

  return [...tally.values()]
    .filter((row) => row.seen >= 3 && row.pass === row.seen)
    .map((row) => ({
      goal_key: row.goalKey,
      check: row.key,
      passed_for: `${row.pass} of ${row.seen} people`,
      why_this_matters:
        "A check that has never returned false is probably not looking at the person. Read one probe and compare the scope it asked for with the scope the response says it used, then repair it with set_checks.",
    }));
}

interface DiscriminationResult {
  key: string;
  tool: string;
  verdict: "discriminates" | "identical" | "untested";
  note?: string;
}

/**
 * Runs each proposed check against two different people and compares the answers.
 *
 * This is the cheapest possible test of the only property a check must have: that it can
 * tell one person from another. A check bound to a tool that ignores its scoping argument
 * returns the caller's own data both times, passes for everybody, and ends every campaign
 * it touches. Nothing downstream can detect that from a single response — but two
 * responses side by side make it obvious.
 *
 * Untested is not a failure. With fewer than two people on file there is nothing to
 * compare, and a campaign should not be blocked on that.
 */
async function discriminationTest(
  orgId: string,
  productId: string,
  checks: Array<Record<string, unknown>>,
): Promise<DiscriminationResult[]> {
  const db = await getDb();
  const { McpClient } = await import("../client.js");
  const { schemasFor } = await import("../schemas.js");
  const { resolveSecret } = await import("../../crypto/broker.js");
  const { scopeEchoMismatches } = await import("../../engine/verify.js");

  const people = await db.collection(C.people).find({ orgId, productId }).limit(2).toArray();
  const out: DiscriminationResult[] = [];

  for (const check of checks) {
    const key = String(check.key);
    const tool = String(check.tool);
    const checkArgs = (check.args ?? {}) as Record<string, string>;

    if (people.length < 2) {
      out.push({ key, tool, verdict: "untested", note: "fewer than two people on file" });
      continue;
    }
    // A check taking no per-person argument cannot possibly discriminate, and needs no
    // network call to prove it.
    if (!Object.values(checkArgs).some((ref) => ref.startsWith("$person."))) {
      out.push({ key, tool, verdict: "identical", note: "no $person argument, so it asks the same question for everyone" });
      continue;
    }

    try {
      const connection = await db
        .collection(C.connections)
        .findOne({ _id: new ObjectId(String(check.connectionId)), orgId });
      if (!connection?.serverUrl) {
        out.push({ key, tool, verdict: "untested", note: "connection not found" });
        continue;
      }
      const token = await resolveSecret(orgId, String(check.connectionId), "engine.discriminate");
      const client = new McpClient(String(connection.serverUrl), token, await schemasFor(String(check.connectionId)));

      const answers: string[] = [];
      const echoes: string[] = [];
      for (const person of people) {
        const sent = resolveCheckArgs(checkArgs, person);
        const payload = await client.callTool(tool, sent);
        answers.push(JSON.stringify(payload ?? null));
        const mismatch = scopeEchoMismatches(sent, payload);
        if (mismatch.length) {
          echoes.push(mismatch.map((m) => `${m.arg}: asked ${m.sent}, answered about ${m.echoed}`).join("; "));
        }
      }

      const identical = answers[0] === answers[1];
      out.push({
        key,
        tool,
        verdict: identical ? "identical" : "discriminates",
        ...(echoes.length ? { note: echoes[0] } : {}),
      });
    } catch (err) {
      out.push({ key, tool, verdict: "untested", note: err instanceof Error ? err.message : String(err) });
    }
  }

  return out;
}

/** The same "$person.email" resolution the engine uses at verification time. */
function resolveCheckArgs(args: Record<string, string>, person: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(args)) {
    if (!ref.startsWith("$")) {
      out[name] = ref;
      continue;
    }
    let cursor: unknown = { person };
    for (const part of ref.slice(1).split(".")) {
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

async function refuseUnverifiedSuccess(
  instance: Record<string, unknown>,
  orgId: string,
  productId: string,
): Promise<string | null> {
  const db = await getDb();
  const goal = await db
    .collection(C.goals)
    .findOne({ orgId, productId, key: String(instance.goalKey) });
  if (!goal) return `campaign "${String(instance.goalKey)}" no longer exists`;

  const checks = (goal.checks ?? []) as Array<{ key: string; describedAs?: string }>;
  if (checks.length === 0) {
    return "this campaign has no verification plan, so nothing can prove success. Call verifiers and set_checks first.";
  }

  const results = (instance.checkResults ?? {}) as Record<string, boolean>;
  const unmet = checks.filter((check) => results[check.key] !== true);
  if (unmet.length === 0) return null;

  const detail = unmet
    .map((check) => `${check.key} (${results[check.key] === false ? "returned false" : "never resolved"})`)
    .join(", ");
  return `not every check has passed: ${detail}. Success means all of them. If a check cannot pass because it is bound to the wrong tool or an argument the provider ignores, fix it with set_checks — do not mark success around it.`;
}

/** How far ahead the compose routine writes. Further out and the person usually signs up or leaves first. */
const COMPOSE_WINDOW_MS = 48 * 3_600_000;
/** Two written ahead is a healthy buffer; below that the sequence is at risk of running dry. */
const COMPOSE_BUFFER_DEPTH = 2;

/**
 * Every product id supplied by a caller is checked against their own organisation. A
 * guessed id from another tenant resolves to nothing rather than to someone else's data.
 */
async function assertProduct(productId: string, ctx: ToolCtx): Promise<string> {
  const db = await getDb();
  const product = await db
    .collection(C.products)
    .findOne({ _id: new ObjectId(productId), orgId: ctx.orgId });
  if (!product) throw new Error(`product ${productId} not found`);
  return ctx.orgId;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_products",
    description: "Every product this token can act on, with its goals and how much work is waiting.",
    inputSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      const db = await getDb();
      const products = await db.collection(C.products).find({ orgId: ctx.orgId, status: "active" }).toArray();
      return Promise.all(
        products.map(async (p) => {
          const s = { orgId: String(p.orgId), productId: String(p._id) };
          return {
            product_id: String(p._id),
            name: String(p.name),
            unclassified: await db.collection(C.people).countDocuments({ ...s, needsClassification: true }),
            active_goals: await db.collection(C.goalInstances).countDocuments({ ...s, status: "active" }),
            awaiting_approval: await db.collection(C.actions).countDocuments({ ...s, status: "awaiting_approval" }),
          };
        }),
      );
    },
  },

  {
    name: "sweep",
    description:
      "One packet of everything needing judgment for a product: unclassified leads, goal instances without a plan, buffers running low, replies waiting. Start every routine run here. An empty packet means stop.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "Product to sweep. Omit to sweep every product." },
        limit: { type: "number", description: "Max items per section. Default 25." },
        scope: {
          type: "string",
          enum: ["all", "monitor", "plan", "compose"],
          description:
            "Which slice of work to return, so separate routines run on separate schedules without duplicating each other. monitor = everyone in an active campaign, with their latest probe results, replies and unsettled checks — where they are, whether they are done, what happens next; plan = unclassified people, campaigns with no pipeline, campaigns with no verification plan; compose = steps due inside 48 hours. Defaults to all.",
        },
      },
    },
    async handler(args, ctx) {
      const db = await getDb();
      const now = new Date();
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const scope = String(args.scope ?? "all");
      const wants = (section: string) => scope === "all" || scope === section;
      const productIds = str(args.product_id)
        ? [str(args.product_id) as string]
        : (await db.collection(C.products).find({ orgId: ctx.orgId, status: "active" }).toArray()).map((p) =>
            String(p._id),
          );

      const packet = [];
      for (const productId of productIds) {
        const orgId = await assertProduct(productId, ctx);
        const s = { orgId, productId };

        const unclassified = wants("plan")
          ? await db
              .collection(C.people)
              .find({ ...s, needsClassification: true, suppressedAt: { $exists: false } })
              .limit(limit)
              .toArray()
          : [];

        const activeGoals = await db.collection(C.goalInstances).find({ ...s, status: "active" }).limit(200).toArray();
        const planned = new Set(
          activeGoals.filter((g) => g.currentPlanId).map((g) => String(g._id)),
        );

        // A goal instance with no plan has had its welcome and nothing since — that is the
        // gap a routine exists to close.
        const needPlan = wants("plan")
          ? activeGoals.filter((g) => !planned.has(String(g._id))).slice(0, limit)
          : [];

        // Campaigns the UI created but could not write a verification plan for — a browser
        // cannot call Claude, so it marks the work and this is where it is picked up.
        const needVerificationPlan = wants("plan")
          ? await db
              .collection(C.goals)
              // Queried on the condition itself rather than on a flag: a campaign created
              // before the flag existed still has no checks, and still needs a plan.
              .find({ ...s, enabled: true, "checks.0": { $exists: false } })
              .limit(limit)
              .toArray()
          : [];

        // The heart of monitor: everyone still running, with what the engine last saw.
        // Verification and "what next" are the same question about the same person, so
        // they are answered from one packet rather than two passes.
        const inFlight = [];
        for (const goal of wants("monitor") ? activeGoals.slice(0, limit) : []) {
          const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(goal.personId)) });
          const lastSent = await db
            .collection(C.actions)
            .find({ ...s, goalInstanceId: String(goal._id), status: "sent" })
            .sort({ sentAt: -1 })
            .limit(1)
            .toArray();

          inFlight.push({
            goal_instance_id: String(goal._id),
            person_id: String(goal.personId),
            name: person?.name ?? person?.primaryEmail,
            goal_key: String(goal.goalKey),
            segment: (person?.belief as { segment?: string } | undefined)?.segment ?? null,
            temperature: (person?.temp as { band?: string } | undefined)?.band ?? null,
            spent: goal.spent,
            deadline: goal.deadline,
            started_at: goal.startedAt,
            check_results: goal.checkResults ?? {},
            // What the tools actually returned last time, so a verdict rests on data
            // rather than on the engine's reading of it.
            last_probes: goal.probeResults ?? null,
            last_verified_at: goal.lastVerifiedAt ?? null,
            last_message: lastSent[0]
              ? {
                  angle: String(lastSent[0].angle),
                  sent_at: lastSent[0].sentAt,
                  subject: (lastSent[0].content as { subject?: string })?.subject ?? null,
                }
              : null,
          });
        }

        // A buffer is only low if something is actually about to go out. Counting queued
        // messages alone reported people whose next step is three weeks away, which the
        // compose routine then correctly declined to write — a sweep that says "three
        // things to do" followed by a run that does nothing reads as a failure when it
        // was not one.
        const lowBuffers = [];
        for (const goal of wants("compose") ? activeGoals : []) {
          if (!goal.currentPlanId) continue;

          const [queued, plan, written] = await Promise.all([
            db.collection(C.actions).countDocuments({ ...s, goalInstanceId: String(goal._id), status: "queued" }),
            db.collection(C.plans).findOne({ _id: new ObjectId(String(goal.currentPlanId)) }),
            db
              .collection(C.actions)
              .find({ ...s, goalInstanceId: String(goal._id) }, { projection: { planStepId: 1 } })
              .toArray(),
          ]);
          if (queued >= COMPOSE_BUFFER_DEPTH) continue;

          const alreadyWritten = new Set(written.map((a) => Number(a.planStepId)).filter(Number.isFinite));
          const startedAt = new Date(String(goal.startedAt ?? now));
          const upcoming = ((plan?.steps ?? []) as Array<Record<string, unknown>>)
            .map((step, index) => ({
              // plan_goal writes the step as `id`; compose_batch echoes it back as `step_id`
              // and stores it as `planStepId`. All three are the same number.
              step_id: Number(step.id ?? step.step_id ?? index + 1),
              channel: step.channel ? String(step.channel) : null,
              angle: step.angle ? String(step.angle) : null,
              dueAt: new Date(startedAt.getTime() + Number(step.after_days ?? step.afterDays ?? 0) * 86_400_000),
            }))
            .filter((step) => !alreadyWritten.has(step.step_id))
            .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

          const next = upcoming[0];
          if (!next || next.dueAt.getTime() > now.getTime() + COMPOSE_WINDOW_MS) continue;

          lowBuffers.push({
            goal_instance_id: String(goal._id),
            queued,
            // Named so the routine can write exactly what is due rather than guessing.
            next_step: { step_id: next.step_id, channel: next.channel, angle: next.angle, due_at: next.dueAt },
            steps_due_in_window: upcoming.filter((st) => st.dueAt.getTime() <= now.getTime() + COMPOSE_WINDOW_MS).length,
            steps_remaining: upcoming.length,
          });
          if (lowBuffers.length >= limit) break;
        }

        const replies = wants("monitor")
          ? await db
              .collection(C.events)
              .find({ ...s, type: "reply_received", handled: { $ne: true } })
              .limit(limit)
              .toArray()
          : [];

        // Checks the engine ran but could not settle. These are the ones that need a
        // person's judgment rather than another tick.
        const undetermined = wants("monitor")
          ? await db
              .collection(C.events)
              .find({ ...s, type: "check_undetermined", handled: { $ne: true } })
              .sort({ ts: -1 })
              .limit(limit)
              .toArray()
          : [];

        // Campaigns whose every check has been false for a long time while the person is
        // plainly engaged — usually a verification plan pointing at the wrong tool.
        const stale = wants("monitor")
          ? activeGoals
              .filter((g) => {
                const results = (g.checkResults ?? {}) as Record<string, boolean>;
                const anyPassed = Object.values(results).some(Boolean);
                const age = Date.now() - new Date(String(g.startedAt)).getTime();
                return !anyPassed && age > 14 * 86_400_000;
              })
              .slice(0, limit)
          : [];

        // The opposite failure, and the more dangerous one. A check that has never
        // returned false is not evidence — it is a constant. It ends campaigns, cancels
        // queued mail and reads as success, all silently. Two checks like this passed
        // everyone on this product before anybody noticed.
        const tooEasy = wants("monitor") ? await undiscriminatingChecks(orgId, productId) : [];

        packet.push({
          product_id: productId,
          unclassified: unclassified.map((p) => ({
            person_id: String(p._id),
            email: String(p.primaryEmail ?? ""),
            name: String(p.name ?? ""),
            role: String(p.role ?? ""),
            company_domain: String(p.companyDomain ?? ""),
          })),
          in_flight: inFlight,
          need_verification_plan: needVerificationPlan.map((g) => ({
            goal_key: String(g.key),
            name: String(g.name),
            success: g.success,
            // Chosen by whoever created the campaign — they know where the truth lives, so
            // the only open question is which of that server's tools to ask.
            verify_connection_id: g.verifyConnectionId ?? null,
            hint: g.verifyHint ?? null,
            note: "Call verifiers to see what this connection exposes, then set_checks. Until then this campaign cannot tell when anyone succeeds.",
          })),
          need_plan: needPlan.map((g) => ({
            goal_instance_id: String(g._id),
            person_id: String(g.personId),
            goal_key: String(g.goalKey),
            spent: g.spent,
          })),
          low_buffers: lowBuffers,
          replies_waiting: replies.map((e) => ({ event_id: String(e._id), person_id: String(e.personId) })),
          undetermined_checks: undetermined.map((e) => ({
            event_id: String(e._id),
            person_id: String(e.personId),
            detail: e.payload,
          })),
          verification_looks_wrong: stale.map((g) => ({
            goal_instance_id: String(g._id),
            person_id: String(g.personId),
            goal_key: String(g.goalKey),
            started_at: g.startedAt,
          })),
          verification_too_easy: tooEasy,
        });
      }

      const total = packet.reduce(
        (n, p) =>
          n +
          p.unclassified.length +
          p.need_verification_plan.length +
          p.need_plan.length +
          p.in_flight.length +
          p.low_buffers.length +
          p.replies_waiting.length +
          p.undetermined_checks.length +
          p.verification_looks_wrong.length +
          p.verification_too_easy.length,
        0,
      );
      return { scope, total_work_items: total, products: packet };
    },
  },

  {
    name: "lead_card",
    description:
      "Everything about one person in a single call: identity, enrichment, belief, temperature, their goal, every touch sent and what came back.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" }, person_id: { type: "string" } },
      required: ["product_id", "person_id"],
    },
    async handler(args, ctx) {
      const db = await getDb();
      const productId = String(args.product_id);
      const orgId = await assertProduct(productId, ctx);
      const person = await db
        .collection(C.people)
        .findOne({ _id: new ObjectId(String(args.person_id)), orgId, productId });
      if (!person) throw new Error("person not found");

      const [goal, actions, events, product] = await Promise.all([
        db.collection(C.goalInstances).findOne({ orgId, productId, personId: String(person._id), status: "active" }),
        db
          .collection(C.actions)
          .find({ orgId, productId, personId: String(person._id) })
          .sort({ dueAt: 1 })
          .toArray(),
        db.collection(C.events).find({ orgId, personId: String(person._id) }).sort({ ts: -1 }).limit(50).toArray(),
        db.collection(C.products).findOne({ _id: new ObjectId(productId) }),
      ]);

      const goalDef = goal
        ? await db.collection(C.goals).findOne({ orgId, productId, key: String(goal.goalKey) })
        : null;

      return {
        person: {
          person_id: String(person._id),
          email: person.primaryEmail,
          name: person.name,
          role: person.role,
          company_domain: person.companyDomain,
          // Absent company plus a personal address means there is nothing on the web to
          // find. The only signal such a lead carries is how they arrived.
          email_kind: person.emailKind ?? "unknown",
          arrivals: person.arrivals ?? [],
          last_enriched_at: person.lastEnrichedAt ?? null,
          // Every angle already spent on this human. plan_goal refuses the ones they
          // ignored, so reading this first is cheaper than being refused.
          angles_tried: await anglesTriedOn(orgId, productId, String(person._id)),
          timezone: person.timezone,
          stage: person.stage,
          consent: person.consent,
          enrichment: person.enrichment ?? null,
        },
        belief: person.belief ?? null,
        temperature: person.temp ?? null,
        goal: goal
          ? {
              goal_instance_id: String(goal._id),
              goal_key: goal.goalKey,
              spent: goal.spent,
              deadline: goal.deadline,
              budget: goalDef?.budget,
              success: goalDef?.success,
              cadence_by_temp: goalDef?.cadenceByTemp,
            }
          : null,
        // Prior claims are supplied so the next message never repeats or contradicts one.
        touches: actions.map((a) => ({
          action_id: String(a._id),
          channel: a.channel,
          angle: a.angle,
          status: a.status,
          sent_at: a.sentAt ?? null,
          subject: (a.content as { subject?: string })?.subject ?? null,
          claims_made: (a.content as { claimsMade?: string[] })?.claimsMade ?? [],
        })),
        events: events.map((e) => ({ type: e.type, ts: e.ts, payload: e.payload })),
        product_config: product?.config ?? null,
        // What each channel can actually carry. Without this, copy gets written to an
        // email's shape and sent as a WhatsApp message, where it lands badly.
        channels: (
          await db.collection(C.channels).find({ orgId, productId, enabled: true }).toArray()
        ).map((c) => {
          const caps = (c.capabilities ?? {}) as Record<string, unknown>;
          return {
            key: String(c.key),
            status: String(c.status),
            max_subject_chars: caps.maxSubjectLength ?? null,
            max_body_chars: caps.maxBodyLength ?? null,
            html: Boolean(caps.html),
            attachments: Boolean(caps.attachments),
            window_rules: caps.windowRules ?? null,
            reports_back: {
              opens: Boolean(caps.trackingOpens),
              clicks: Boolean(caps.trackingClicks),
              replies: Boolean(caps.inboundReplies),
            },
          };
        }),
      };
    },
  },

  {
    name: "classify",
    description:
      "Store the belief you formed about one or more people: segment, confidence, pain hypothesis, likely objections, ICP fit. Clears their needs-classification flag. Set fit_known false where there was nothing to judge fit on — a bare personal address with no company and no role. Guessing low there is not the same as knowing they are a poor prospect, and the two get different messages.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        results: {
          type: "array",
          description: "One entry per person.",
          items: {
            type: "object",
            properties: {
              person_id: { type: "string" },
              segment: { type: "string" },
              confidence: { type: "number" },
              use_case: { type: "string" },
              pain_hypothesis: { type: "string" },
              objections_likely: { type: "array", items: { type: "string" } },
              icp_fit: { type: "number" },
              fit_known: {
                type: "boolean",
                description:
                  "False when the record carried nothing to judge fit on. Defaults to true.",
              },
              reasoning: { type: "string" },
            },
            required: ["person_id", "segment", "confidence", "icp_fit", "reasoning"],
          },
        },
      },
      required: ["product_id", "results"],
    },
    async handler(args, ctx) {
      const db = await getDb();
      await assertProduct(String(args.product_id), ctx);
      const results = (args.results ?? []) as Array<Record<string, unknown>>;
      let updated = 0;

      for (const r of results) {
        const icpFit = Number(r.icp_fit ?? 0);
        const fitKnown = r.fit_known !== false;
        await db.collection(C.people).updateOne(
          { _id: new ObjectId(String(r.person_id)), orgId: ctx.orgId },
          {
            $set: {
              belief: {
                segment: String(r.segment),
                confidence: Number(r.confidence ?? 0.5),
                useCase: r.use_case ?? undefined,
                painHypothesis: r.pain_hypothesis ?? undefined,
                objectionsLikely: r.objections_likely ?? [],
                icpFit,
                fitKnown,
                intentScore: 0,
                reasoning: String(r.reasoning),
                source: "system",
                updatedAt: new Date(),
              },
              // Fit is known before any engagement, so temperature starts from fit alone.
              // An unknown fit still lands in the cold band, and that is deliberate: the
              // cadence there is the tightest, which is what someone we cannot read needs.
              // termsUsed records that the number came from a guess, so nothing downstream
              // mistakes it for a measurement.
              temp: {
                score: Math.round(icpFit * 40),
                band: icpFit >= 0.7 ? "warm" : "cold",
                computedAt: new Date(),
                termsUsed: [fitKnown ? "fit" : "fit_unknown"],
              },
              needsClassification: false,
            },
          },
        );
        updated++;
      }
      return { updated };
    },
  },

  {
    name: "plan_goal",
    description:
      "Write the pipeline for one person: the ordered steps, each with channel, angle, timing and why. Every channel must be one the campaign allows — lead_card lists what is connected and what each can carry. Around a third of the steps must use an angle that is not already proven for this segment, and a plan of three or more steps may not use one angle throughout; both are refused rather than warned about, because spending every step on the current favourite is how the untested angles never get the sends that would prove them. Stored as a new version; the previous plan is kept with your rationale for replacing it.",
    inputSchema: {
      type: "object",
      properties: {
        goal_instance_id: { type: "string" },
        rationale: { type: "string", description: "Why this plan, or why the previous one was abandoned." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              after_days: { type: "number", description: "Days from now this step should fire." },
              channel: { type: "string" },
              angle: { type: "string" },
              template_key: { type: "string" },
              why: { type: "string" },
              advance_if: { type: "string" },
            },
            required: ["id", "after_days", "channel", "angle", "why"],
          },
        },
      },
      required: ["goal_instance_id", "rationale", "steps"],
    },
    async handler(args, ctx) {
      const db = await getDb();
      const goalInstanceId = String(args.goal_instance_id);
      const instance = await db
        .collection(C.goalInstances)
        .findOne({ _id: new ObjectId(goalInstanceId), orgId: ctx.orgId });
      if (!instance) throw new Error("goal instance not found");

      // A plan that names a channel the campaign does not allow would queue messages that
      // can never send, so it is refused rather than stored.
      const goalDef = await db
        .collection(C.goals)
        .findOne({ orgId: ctx.orgId, productId: String(instance.productId), key: String(instance.goalKey) });
      const allowed = (goalDef?.allowedChannels ?? []) as string[];
      if (allowed.length > 0) {
        const steps = (args.steps ?? []) as Array<{ channel?: string }>;
        const stray = steps.map((st) => String(st.channel)).filter((ch) => !allowed.includes(ch));
        if (stray.length > 0) {
          throw new Error(
            `This campaign may only use ${allowed.join(", ")}. The plan asks for ${[...new Set(stray)].join(", ")}.`,
          );
        }
      }

      // The exploration floor. Refused rather than warned about, for the same reason the
      // channel check above is: a plan that spends every step on the current favourite is
      // the one way this system stops learning, and it is the plan a model most wants to
      // write.
      const person = await db
        .collection(C.people)
        .findOne({ _id: new ObjectId(String(instance.personId)) }, { projection: { belief: 1 } });
      const segment = (person?.belief as { segment?: string } | undefined)?.segment;
      const angles = ((args.steps ?? []) as Array<{ angle?: string }>).map((st) => String(st.angle));
      const block = await explorationBlock(ctx.orgId, String(instance.productId), segment, angles);
      if (block) throw new Error(block);

      // What this person has already ignored. Attempt two opening on the line that lost
      // attempt one is the cheapest mistake in the system and the easiest to make: the
      // table says the angle works, and for this human it demonstrably does not.
      const tried = await anglesTriedOn(ctx.orgId, String(instance.productId), String(instance.personId));
      const spent = spentAngles(tried);
      const repeats = [...new Set(angles.filter((a) => spent.has(a)))];
      if (repeats.length > 0) {
        throw new Error(
          `This person has already been sent ${repeats.join(", ")} and did not act on it. ` +
            `Reusing it means saying the thing that already failed on them, more loudly. ` +
            `lead_card lists every angle they have seen — pick one they have not.`,
        );
      }

      const previous = await db
        .collection(C.plans)
        .find({ goalInstanceId })
        .sort({ version: -1 })
        .limit(1)
        .toArray();
      const version = (previous[0]?.version ?? 0) + 1;

      const planId = new ObjectId();
      await db.collection(C.plans).insertOne({
        _id: planId,
        orgId: String(instance.orgId),
        // Every other collection is scoped by both. Without productId a plan cannot be
        // found by the product that owns it, only by walking its goal instance.
        productId: String(instance.productId),
        goalInstanceId,
        version,
        steps: args.steps,
        rationale: String(args.rationale),
        createdBy: "claude",
        createdAt: new Date(),
      });
      await db
        .collection(C.goalInstances)
        .updateOne({ _id: instance._id }, { $set: { currentPlanId: String(planId) } });

      return { plan_id: String(planId), version, steps: (args.steps as unknown[]).length };
    },
  },

  {
    name: "compose_batch",
    description:
      "Write the actual copy for upcoming touches and queue them. Each becomes a scheduled message; the engine sends it when due, under every guardrail. Never repeat a claim already made to this person.",
    inputSchema: {
      type: "object",
      properties: {
        goal_instance_id: { type: "string" },
        touches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step_id: { type: "number" },
              after_days: { type: "number" },
              channel: { type: "string" },
              angle: { type: "string" },
              subject: { type: "string" },
              body: { type: "string", description: "Markdown. Must not contain an unsubscribe line; one is appended." },
              claims_made: { type: "array", items: { type: "string" } },
              rationale: { type: "string" },
            },
            required: ["step_id", "after_days", "channel", "angle", "body", "rationale"],
          },
        },
      },
      required: ["goal_instance_id", "touches"],
    },
    async handler(args, ctx) {
      const db = await getDb();
      const goalInstanceId = String(args.goal_instance_id);
      const instance = await db
        .collection(C.goalInstances)
        .findOne({ _id: new ObjectId(goalInstanceId), orgId: ctx.orgId });
      if (!instance) throw new Error("goal instance not found");

      const orgId = String(instance.orgId);
      const productId = String(instance.productId);
      const touches = (args.touches ?? []) as Array<Record<string, unknown>>;
      const queued: string[] = [];

      for (const t of touches) {
        const channelKey = String(t.channel);
        const channel = await db
          .collection(C.channels)
          .findOne({ orgId, productId, key: channelKey, enabled: true, status: "healthy" });
        if (!channel) continue;

        const actionId = new ObjectId();
        const body = String(t.body);
        try {
          await db.collection(C.actions).insertOne({
            _id: actionId,
            orgId,
            productId,
            goalInstanceId,
            personId: String(instance.personId),
            planStepId: Number(t.step_id),
            channel: channelKey,
            channelId: String(channel._id),
            angle: String(t.angle),
            rationale: String(t.rationale),
            // Claude writes the slot, not the whole message: the greeting, call to action
            // and opt-out block are the template's, and are added when this renders.
            content: {
              subject: t.subject ? String(t.subject) : undefined,
              bodyMd: "",
              slotText: body,
              personalizationUsed: [],
              claimsMade: (t.claims_made ?? []) as string[],
              wordCount: body.split(/\s+/).filter(Boolean).length,
            },
            assetIds: [],
            next: {},
            signals: [],
            idempotencyKey: `${goalInstanceId}:step:${String(t.step_id)}`,
            status: "queued",
            dueAt: new Date(Date.now() + Number(t.after_days ?? 1) * 86_400_000),
            cost: 0,
          });
          queued.push(String(actionId));
        } catch (err) {
          // A duplicate key means this step is already queued — the index doing its job.
          if (!(err instanceof Error && err.message.includes("E11000"))) throw err;
        }
      }
      return { queued: queued.length, action_ids: queued };
    },
  },

  {
    name: "poll_sources",
    description: "Fetch every source that is due now: ingest new leads, open their goals, queue their first touch.",
    inputSchema: { type: "object", properties: { product_id: { type: "string" } } },
    async handler(args, ctx) {
      const productId = str(args.product_id);
      if (!productId) throw new Error("product_id is required");
      const orgId = await assertProduct(productId, ctx);

      const ids = await dueSources(orgId);
      const results = [];
      for (const id of ids) {
        try {
          // The cursor is internal bookkeeping. Handing the model an opaque position it
          // cannot act on only invites it to reason about one.
          const { nextCursor: _cursor, ...summary } = await runSource(id);
          results.push({ source_id: id, ...summary });
        } catch (err) {
          results.push({ source_id: id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { sources_run: ids.length, results };
    },
  },

  {
    name: "fire_due",
    description:
      "Send every message that is due, under all guardrails. Dry run by default — pass dry_run false to actually deliver.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        dry_run: { type: "boolean", description: "Defaults to true." },
      },
      required: ["product_id"],
    },
    async handler(args, ctx) {
      const productId = String(args.product_id);
      const orgId = await assertProduct(productId, ctx);
      const dryRun = args.dry_run === false ? false : true;
      const sent = await fireDue({
        orgId,
        productId,
        dryRun,
        adapterFor: (channelId) => resolveChannelAdapter(orgId, channelId),
      });
      const reconciled = await reconcileDispatched(orgId, productId);
      return { dry_run: dryRun, ...sent, reconciled };
    },
  },

  {
    name: "approve",
    description: "Release or reject messages that are held for review.",
    inputSchema: {
      type: "object",
      properties: {
        action_ids: { type: "array", items: { type: "string" } },
        decision: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["action_ids", "decision"],
    },
    async handler(args, ctx) {
      const db = await getDb();
      const ids = (args.action_ids as string[]).map((id) => new ObjectId(id));
      const status = args.decision === "approve" ? "queued" : "skipped";
      const result = await db
        .collection(C.actions)
        .updateMany({ _id: { $in: ids }, orgId: ctx.orgId, status: "awaiting_approval" }, { $set: { status } });
      return { updated: result.modifiedCount, decision: args.decision };
    },
  },

  {
    name: "report",
    description: "Funnel and delivery numbers for a product.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"],
    },
    async handler(args, ctx) {
      const db = await getDb();
      const productId = String(args.product_id);
      const orgId = await assertProduct(productId, ctx);
      const s = { orgId, productId };
      const byStatus = await db
        .collection(C.actions)
        .aggregate([{ $match: s }, { $group: { _id: "$status", n: { $sum: 1 } } }])
        .toArray();

      return {
        people: await db.collection(C.people).countDocuments(s),
        unclassified: await db.collection(C.people).countDocuments({ ...s, needsClassification: true }),
        goals_active: await db.collection(C.goalInstances).countDocuments({ ...s, status: "active" }),
        goals_succeeded: await db.collection(C.goalInstances).countDocuments({ ...s, status: "succeeded" }),
        actions_by_status: Object.fromEntries(byStatus.map((r) => [String(r._id), r.n])),
      };
    },
  },
];

/**
 * Lets Claude write a campaign's verification plan at creation time.
 *
 * It reads the plain-words success sentence and the tools every connected verifier
 * exposes, then proposes a tool and an assertion for each thing that has to be true. The
 * engine runs those forever afterwards without a model.
 */
TOOLS.push({
  name: "verifiers",
  description:
    "Everything connected that could answer 'has this person done X yet' — each connection with its tools and their input schemas. Call this before proposing how a campaign will verify success.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      connection_id: {
        type: "string",
        description: "Narrow to one connection — the campaign names which it should be verified against.",
      },
    },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);

    const only = args.connection_id ? { _id: new ObjectId(String(args.connection_id)) } : {};
    const connections = await db.collection(C.connections).find({ orgId, productId, ...only }).toArray();
    const out = [];
    for (const connection of connections) {
      const binding = await db.collection(C.mcpBindings).findOne({ orgId, connectionId: String(connection._id) });
      const tools = (binding?.discoveredTools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown }>;
      if (tools.length === 0) continue;
      out.push({
        connection_id: String(connection._id),
        provider: String(connection.provider),
        status: String(connection.status),
        tools: tools.map((t) => ({ name: t.name, description: t.description, input: t.inputSchema })),
      });
    }
    return {
      verifiers: out,
      assertion_language: {
        exists: "the response contains anything at all",
        "count >= N": "the first array in the response has at least N entries",
        "$.path == value": "a value at that path equals a literal",
        "$.path != value": "a value at that path differs from a literal",
      },
      argument_refs: ["$person.email", "$person.name", "$person.companyDomain", "$person.productUid", "$since"],
    };
  },
});

TOOLS.push({
  name: "set_checks",
  description:
    "Store how a campaign will verify success. Each check names a connection, a tool, its arguments and an assertion. The engine runs them on every tick without a model, so they must be answerable from the tools alone.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      goal_key: { type: "string" },
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "Short identifier, e.g. account_created" },
            describedAs: { type: "string", description: "What this proves, in plain words" },
            connectionId: { type: "string" },
            tool: { type: "string" },
            args: { type: "object", description: 'Argument name to value or $ref, e.g. {"query":"$person.email"}' },
            assert: { type: "string", description: 'exists · count >= 2 · $.plan != trial' },
            latch: { type: "boolean", description: "True once means true forever. Defaults true." },
          },
          required: ["key", "describedAs", "connectionId", "tool", "assert"],
        },
      },
    },
    required: ["product_id", "goal_key", "checks"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const checks = (args.checks ?? []) as Array<Record<string, unknown>>;
    if (checks.length === 0) throw new Error("a campaign needs at least one check");

    // Every check is tried against two different people before it is trusted. A check that
    // answers identically for both is not looking at the person — it is describing the
    // caller's own account, and it will pass for everyone forever.
    const discrimination = await discriminationTest(orgId, productId, checks);
    const blind = discrimination.filter((r: DiscriminationResult) => r.verdict === "identical");
    if (blind.length > 0 && args.accept_undiscriminating !== true) {
      throw new Error(
        `these checks answered identically for two different people, so they cannot tell them apart: ${blind
          .map((r: DiscriminationResult) => `${r.key} (${r.tool}${r.note ? ` — ${r.note}` : ""})`)
          .join("; ")}. Usually the scoping argument is one the provider ignores because it needs a privilege this token does not have — look at what the response echoes back. Bind them to something person-specific, or pass accept_undiscriminating if the check is genuinely org-wide and another check carries the per-person proof.`,
      );
    }

    await db.collection(C.goals).updateOne(
      { orgId, productId, key: String(args.goal_key) },
      {
        $set: {
          checks: checks.map((c) => ({ ...c, args: c.args ?? {}, latch: c.latch ?? true, proposedBy: "claude" })),
          needsVerificationPlan: false,
          checksWrittenAt: new Date(),
          discrimination,
        },
      },
    );
    return { goal_key: String(args.goal_key), checks: checks.length, discrimination };
  },
});

/**
 * Runs a person's checks now and hands back the raw responses.
 *
 * The engine settles the clear cases on its own tick. This exists for the ones it cannot:
 * a response the assertion could not read, or a picture that does not add up. Claude gets
 * what the tools actually returned and decides.
 */
TOOLS.push({
  name: "verify_person",
  description:
    "Run a person's campaign checks right now and return the raw tool responses alongside what the engine made of them. Use when a check came back undetermined, or when the recorded state does not match what you can see.",
  inputSchema: {
    type: "object",
    properties: { product_id: { type: "string" }, person_id: { type: "string" } },
    required: ["product_id", "person_id"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const personId = String(args.person_id);

    const instance = await db
      .collection(C.goalInstances)
      .findOne({ orgId, productId, personId, status: "active" });
    if (!instance) return { active_campaign: null, note: "No campaign is running for this person." };

    const goal = await db.collection(C.goals).findOne({ orgId, productId, key: instance.goalKey });
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) });
    const checks = (goal?.checks ?? []) as Array<Record<string, unknown>>;

    const { evaluateAssertion } = await import("../../engine/verify.js");
    const { McpClient } = await import("../../mcp/client.js");
    const { schemasFor } = await import("../../mcp/schemas.js");
    const { resolveSecret } = await import("../../crypto/broker.js");

    const results = [];
    for (const check of checks) {
      try {
        const connection = await db
          .collection(C.connections)
          .findOne({ _id: new ObjectId(String(check.connectionId)), orgId });
        if (!connection?.serverUrl) {
          results.push({ key: check.key, error: "verifier not found" });
          continue;
        }
        const token = await resolveSecret(orgId, String(check.connectionId), "mcp.verify_person");
        const client = new McpClient(
          String(connection.serverUrl),
          token,
          await schemasFor(String(check.connectionId)),
        );

        const argMap: Record<string, unknown> = {};
        for (const [name, ref] of Object.entries((check.args ?? {}) as Record<string, string>)) {
          argMap[name] = ref.startsWith("$person.")
            ? (person as Record<string, unknown> | null)?.[ref.slice(8)]
            : ref === "$since"
              ? new Date(String(instance.startedAt)).toISOString()
              : ref;
        }

        const payload = await client.callTool(String(check.tool), argMap);
        results.push({
          key: check.key,
          described_as: check.describedAs,
          tool: check.tool,
          args: argMap,
          assertion: check.assert,
          engine_verdict: evaluateAssertion(String(check.assert), payload),
          raw_response: payload,
        });
      } catch (err) {
        results.push({ key: check.key, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      goal_instance_id: String(instance._id),
      goal_key: String(instance.goalKey),
      success_rule: goal?.success,
      recorded: instance.checkResults ?? {},
      checks: results,
    };
  },
});

/**
 * Records Claude's verdict on a check the engine could not settle. Written as a human-style
 * override rather than a silent edit, so the trail shows who decided and why.
 */
TOOLS.push({
  name: "resolve_check",
  description:
    "Settle a check the engine returned as undetermined. Say whether it passed and why. This can complete a campaign, so use it only when the raw response actually supports the verdict.",
  inputSchema: {
    type: "object",
    properties: {
      goal_instance_id: { type: "string" },
      key: { type: "string" },
      passed: { type: "boolean" },
      why: { type: "string", description: "What in the response supports this." },
      event_id: { type: "string", description: "The undetermined event this answers, if any." },
    },
    required: ["goal_instance_id", "key", "passed", "why"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const instance = await db
      .collection(C.goalInstances)
      .findOne({ _id: new ObjectId(String(args.goal_instance_id)), orgId: ctx.orgId });
    if (!instance) throw new Error("campaign not found");

    await db.collection(C.goalInstances).updateOne(
      { _id: instance._id },
      { $set: { [`checkResults.${String(args.key)}`]: Boolean(args.passed) } },
    );
    await db.collection(C.events).insertOne({
      _id: new ObjectId(),
      orgId: ctx.orgId,
      productId: String(instance.productId),
      personId: String(instance.personId),
      source: "system",
      type: "check_resolved",
      payload: { key: args.key, passed: args.passed, why: args.why, by: "claude" },
      ts: new Date(),
    });
    if (args.event_id) {
      await db
        .collection(C.events)
        .updateOne({ _id: new ObjectId(String(args.event_id)) }, { $set: { handled: true } });
    }

    // Re-run so a campaign whose last check just settled completes on the spot rather than
    // waiting for the next tick.
    const { verifyCampaign } = await import("../../engine/verify.js");
    const outcome = await verifyCampaign(ctx.orgId, String(instance._id));
    return { key: String(args.key), passed: Boolean(args.passed), campaign_now: outcome };
  },
});

/**
 * Sets a person's state after reading what the tools actually returned.
 *
 * The engine gathers the evidence and settles only what is beyond doubt. This is where the
 * rest is decided: a response shaped differently from what the assertion expected, someone
 * who signed up under another address, a picture that does not add up. Claude's verdict
 * wins, and it is recorded with its reasoning so the trail shows who decided and why.
 */
TOOLS.push({
  name: "mark_state",
  description:
    "Set the outcome for people in active campaigns after reading their probe results. 'succeeded' is refused unless every check the campaign defines has actually passed — if a check cannot pass because it is bound to the wrong tool or an argument the provider ignores, repair it with set_checks rather than marking success around it. Use 'failed' only for a real ending, not for a check that has simply not passed yet; 'continue' leaves a campaign running with a note about where the person is.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            goal_instance_id: { type: "string" },
            state: { type: "string", enum: ["succeeded", "failed", "continue"] },
            why: { type: "string", description: "What in the evidence supports this." },
            cooling_days: { type: "number", description: "For failed: how long before they may be approached again. Defaults to 90." },
            objection: { type: "string", description: "Anything they said that a later attempt should open on." },
          },
          required: ["goal_instance_id", "state", "why"],
        },
      },
    },
    required: ["product_id", "verdicts"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const verdicts = (args.verdicts ?? []) as Array<Record<string, unknown>>;
    const now = new Date();
    const applied: Array<Record<string, unknown>> = [];

    for (const v of verdicts) {
      const instance = await db
        .collection(C.goalInstances)
        .findOne({ _id: new ObjectId(String(v.goal_instance_id)), orgId, productId });
      if (!instance || instance.status !== "active") continue;

      const state = String(v.state);
      const personId = new ObjectId(String(instance.personId));

      // Succeeded is the verdict that ends a campaign and cancels the rest of its
      // messages, so it is the one that gets checked against the evidence rather than
      // taken on trust. Failure needs no such gate: a person who says no has said no,
      // and no tool will ever prove it.
      if (state === "succeeded") {
        const refusal = await refuseUnverifiedSuccess(instance, orgId, productId);
        if (refusal) {
          applied.push({ goal_instance_id: String(instance._id), state: "refused", why: refusal });
          continue;
        }
      }

      if (state === "continue") {
        await db
          .collection(C.goalInstances)
          .updateOne({ _id: instance._id }, { $set: { lastReviewNote: String(v.why), lastReviewedAt: now } });
        applied.push({ goal_instance_id: String(instance._id), state });
        continue;
      }

      await db.collection(C.goalInstances).updateOne(
        { _id: instance._id },
        {
          $set: {
            status: state === "succeeded" ? "succeeded" : "failed",
            endedAt: now,
            outcome: String(v.why),
            decidedBy: "claude",
          },
        },
      );

      // Congratulating someone and then chasing them twice is the failure this prevents.
      await db.collection(C.actions).updateMany(
        { orgId, goalInstanceId: String(instance._id), status: { $in: ["queued", "awaiting_approval"] } },
        { $set: { status: "skipped", skipReason: `campaign ${state}` } },
      );

      // The verdict is attributed to the messages that earned it, so the angles that
      // actually moved this person are visible to whoever plans the next campaign.
      await stampGoalOutcome(orgId, String(instance._id), state === "succeeded" ? "won" : "lost");

      const coolingDays = typeof v.cooling_days === "number" ? v.cooling_days : 90;
      const personUpdate: Record<string, unknown> = {
        lifecycle: "cooling",
        coolingUntil: new Date(now.getTime() + coolingDays * 86_400_000),
      };
      await db.collection(C.people).updateOne({ _id: personId }, { $set: personUpdate });

      // Objections outlive the campaign that heard them, so a later attempt can open on
      // what the person actually said rather than repeating what already failed.
      if (v.objection) {
        await db.collection(C.people).updateOne({ _id: personId }, {
          $push: { objections: { text: String(v.objection), at: now, source: "claude" } },
        } as never);
      }

      await db.collection(C.events).insertOne({
        _id: new ObjectId(),
        orgId,
        productId,
        personId: String(instance.personId),
        source: "system",
        type: `campaign_${state}`,
        payload: { why: String(v.why), by: "claude" },
        ts: now,
      });

      applied.push({ goal_instance_id: String(instance._id), state, cooling_days: coolingDays });
    }

    return { applied: applied.length, verdicts: applied };
  },
});

/**
 * Lets a scheduled routine tell the engine it exists.
 *
 * Nothing else can. The schedule lives in Claude, and this app has no way to read it — so
 * the console would otherwise have to trust a cron somebody typed into a form once and
 * never corrected. Instead the routine re-declares its own schedule on every run, which
 * keeps our copy true and turns silence into a signal: a routine that stops calling in is
 * a routine that stopped.
 */
TOOLS.push({
  name: "register_routine",
  description:
    "Declare which routine you are and the cron you run on. Call this first in every scheduled run. It is what lets the console show when each routine last ran, when it is due next, and raise an alert when one stops firing.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      routine: {
        type: "string",
        enum: [...ROUTINE_KEYS],
        description: "Which routine this session is. Must match the scope you sweep with.",
      },
      cron: {
        type: "string",
        description: "The five-field cron this session is scheduled on, exactly as set in Claude. Example: 5 * * * *",
      },
      note: { type: "string", description: "Anything a person should know about this schedule." },
    },
    required: ["product_id", "routine", "cron"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const key = String(args.routine) as RoutineKey;
    if (!(ROUTINE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`routine must be one of ${ROUTINE_KEYS.join(", ")}`);
    }

    const { cron, nextRunAt } = await registerRoutine({
      orgId,
      productId,
      key,
      cron: String(args.cron),
      note: str(args.note),
    });

    return {
      registered: key,
      cron,
      next_run_at: nextRunAt?.toISOString() ?? null,
      note: "Recorded. Your tool calls from here until you go quiet are logged as this run.",
    };
  },
});

/**
 * What a person would otherwise have to open the console to find out: which routines are
 * set up, when each last ran, and whether any of them has stopped.
 */
TOOLS.push({
  name: "routine_status",
  description:
    "Which routines are registered for a product, when each last ran and what it achieved, when each is due next, and which are overdue. Use this to answer 'are my routines healthy' without opening the console.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      runs: { type: "number", description: "How many recent runs to include per routine. Default 5, max 25." },
    },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const perRoutine = Math.min(typeof args.runs === "number" ? args.runs : 5, 25);

    const [health, recent] = await Promise.all([
      routineHealth(orgId, productId),
      listRuns(orgId, productId, { limit: 200 }),
    ]);

    const routines = health.map((h) => {
      const runs = recent.filter((r) => r.routine === h.key).slice(0, perRoutine);
      return {
        routine: h.key,
        registered: h.registered,
        enabled: h.enabled,
        state: h.state,
        cron: h.cron,
        last_run_at: h.lastRunAt?.toISOString() ?? null,
        last_status: h.lastStatus,
        next_run_at: h.nextRunAt?.toISOString() ?? null,
        late_by_minutes: h.lateByMinutes,
        totals_across_recent_runs: sumCounters(runs),
        recent_runs: runs.map((r) => ({
          at: r.startedAt,
          status: r.status,
          seconds: Math.round(r.ms / 1000),
          calls: r.calls,
          errors: r.errors,
          did: r.counters,
          first_error: r.firstError,
        })),
      };
    });

    const engine = recent.find((r) => r.routine === "engine");
    const problems = routines
      .filter((r) => r.state === "late" || r.state === "never" || (!r.registered && r.routine !== "compose"))
      .map((r) =>
        r.registered
          ? `${r.routine} is ${r.state} — last run ${r.last_run_at ?? "never"}`
          : `${r.routine} has never registered, so nothing is scheduled for it`,
      );

    return {
      product_id: productId,
      routines,
      last_engine_tick_with_work: engine
        ? { at: engine.startedAt, did: engine.counters, status: engine.status }
        : null,
      problems,
      healthy: problems.length === 0,
    };
  },
});

// ── brand and templates ───────────────────────────────────────────────────────

TOOLS.push({
  name: "get_brand",
  description:
    "The product's resolved brand kit: palette, type, shape, logo and footer, with where each value came from. Read it before writing copy — a headline written for a 34px display face is a different sentence from one written for a paragraph.",
  inputSchema: {
    type: "object",
    properties: { product_id: { type: "string" } },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const productId = await assertProduct(String(args.product_id), ctx);
    const { loadBrandKit } = await import("../../engine/brand.js");
    const db = await getDb();
    const kit = await loadBrandKit(ctx.orgId, productId);
    const sources = await db
      .collection(C.brandSources)
      .find({ orgId: ctx.orgId, productId })
      .sort({ precedence: 1 })
      .toArray();

    return {
      product_id: productId,
      // A kit with no provenance is the neutral default, which is worth saying plainly:
      // copy written as though the brand were known would be a guess.
      branded: Object.keys(kit.provenance ?? {}).length > 0,
      color: kit.color,
      font: kit.font,
      shape: kit.shape,
      logo: kit.logo ?? null,
      footer: kit.footer,
      provenance: kit.provenance,
      sources: sources.map((source) => ({
        name: String(source.name),
        kind: String(source.kind),
        precedence: Number(source.precedence),
        health: (source.health as { status?: string })?.status ?? "pending",
        fields: Object.keys((source.resolved ?? {}) as object),
      })),
    };
  },
});

TOOLS.push({
  name: "upsert_template",
  description:
    "Create or replace a template. Blocks are structure and copy; appearance comes from the brand kit at render time, so never write HTML or colours here. A new template starts as a draft until someone activates it.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      key: { type: "string", description: "Stable identifier. Reusing one replaces that template's blocks." },
      name: { type: "string" },
      channel: { type: "string" },
      format: {
        type: "string",
        enum: ["html", "text"],
        description:
          "Defaults to html, which carries the plain text alongside. Choose text where a plain note reads better than a designed one.",
      },
      stage: { type: "string", description: "Defaults to first_touch." },
      scope: { type: "string", enum: ["product_default", "segment"], description: "Defaults to product_default." },
      segment_key: { type: "string" },
      status: { type: "string", enum: ["draft", "active", "paused"] },
      max_words: { type: "number" },
      blocks: {
        type: "array",
        description:
          "In order. Types: subject, preheader, heading, text, slot, list, card, callout, divider, image, cta, system. A slot is what you fill per person later; give every slot a fallback so a first touch can fire before any session has run.",
        items: { type: "object", additionalProperties: true },
      },
      rationale: { type: "string", description: "Why this template, or what the previous one got wrong." },
    },
    required: ["product_id", "key", "blocks"],
  },
  async handler(args, ctx) {
    const productId = await assertProduct(String(args.product_id), ctx);
    const db = await getDb();
    const { block } = await import("../../schemas/template.js");
    const { z } = await import("zod");

    // Validated here rather than at render time: a malformed block that reaches the
    // engine fails per message, hours later, in whatever words Mongo chose.
    const parsed = z.array(block).min(1).safeParse(args.blocks);
    if (!parsed.success) {
      throw new Error(`blocks are not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }

    const key = String(args.key);
    const channel = str(args.channel) ?? "email";
    const scope = str(args.scope) ?? "product_default";
    const segmentKey = str(args.segment_key);
    const filter: Record<string, unknown> = { orgId: ctx.orgId, productId, key, channel, scope };
    if (scope === "segment") {
      if (!segmentKey) throw new Error("a segment-scoped template needs segment_key");
      filter.segmentKey = segmentKey;
    }

    const existing = await db.collection(C.templates).findOne(filter);
    const maxWords = typeof args.max_words === "number" ? Math.round(args.max_words) : undefined;

    await db.collection(C.templates).updateOne(
      filter,
      {
        $set: {
          ...filter,
          name: str(args.name) ?? key,
          format: str(args.format) === "text" || channel !== "email" ? "text" : "html",
          stage: str(args.stage) ?? "first_touch",
          blocks: parsed.data,
          constraints: {
            maxWords: maxWords ?? (existing?.constraints as { maxWords?: number } | undefined)?.maxWords ?? (channel === "email" ? 140 : 45),
            noClaims: ((existing?.constraints as { noClaims?: string[] } | undefined)?.noClaims) ?? [],
          },
          // Replacing a template's blocks is a new version of it, not an edit of the one
          // whose numbers were collected against different words.
          version: Number(existing?.version ?? 0) + 1,
          status: str(args.status) ?? (existing ? String(existing.status) : "draft"),
          createdBy: "claude",
          rationale: str(args.rationale),
        },
        $setOnInsert: {
          _id: new ObjectId(),
          assetIds: [],
          stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
        },
      },
      { upsert: true },
    );

    const saved = await db.collection(C.templates).findOne(filter);
    return {
      template_id: String(saved?._id),
      key,
      version: Number(saved?.version ?? 1),
      status: String(saved?.status),
      replaced: Boolean(existing),
    };
  },
});

TOOLS.push({
  name: "preview_template",
  description:
    "Render a template exactly as the engine would, for a real person or a sample one. Returns the subject, the plain-text part, validation, and the size of the HTML part. Check your own work here before a human sees it.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      template_id: { type: "string" },
      key: { type: "string", description: "Alternative to template_id." },
      person_id: { type: "string", description: "Omit to render against a sample lead." },
      include_html: { type: "boolean", description: "Defaults to false — the HTML is large and rarely worth the context." },
    },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const productId = await assertProduct(String(args.product_id), ctx);
    const db = await getDb();
    const { renderTemplate, resolveBlocks } = await import("../../engine/compose.js");
    const { renderHtml } = await import("../../engine/html.js");
    const { loadBrandKit } = await import("../../engine/brand.js");
    const { validate } = await import("../../engine/validate.js");

    const templateId = str(args.template_id);
    const template = templateId
      ? await db.collection(C.templates).findOne({ _id: new ObjectId(templateId), orgId: ctx.orgId, productId })
      : await db.collection(C.templates).findOne({ orgId: ctx.orgId, productId, key: str(args.key) });
    if (!template) throw new Error("template not found");

    const personId = str(args.person_id);
    const person = personId
      ? await db.collection(C.people).findOne({ _id: new ObjectId(personId), orgId: ctx.orgId })
      : null;
    const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) });
    const config = (product?.config ?? {}) as { website?: string; trialLinkTemplate?: string };
    const site = (config.website ?? "https://example.com").replace(/\/$/, "");
    const name = String(person?.name ?? "Priya Nair");
    const id = person ? String(person._id) : "sample";

    const vars = {
      first_name: greetingName(name),
      full_name: name,
      company: String(person?.companyDomain ?? "cloudnine.dev").split(".")[0] || "your team",
      person_id: id,
      trial_link: (config.trialLinkTemplate ?? `${site}/start?p={{person_id}}`).replace("{{person_id}}", id),
      opt_out_url: `${site}/unsubscribe?p=${id}`,
    };

    const blocks = template.blocks as Record<string, unknown>[];
    const rendered = renderTemplate(blocks, vars);
    const constraints = template.constraints as { maxWords?: number; noClaims?: string[] } | undefined;
    const check = validate(rendered, {
      channelKey: String(template.channel),
      maxWords: constraints?.maxWords,
      noClaims: constraints?.noClaims,
    });

    const html =
      String(template.channel) === "email" && String(template.format ?? "html") !== "text"
        ? renderHtml(resolveBlocks(blocks, vars), await loadBrandKit(ctx.orgId, productId))
        : undefined;

    return {
      template_id: String(template._id),
      key: String(template.key),
      rendered_for: person ? { person_id: id, name } : "sample lead",
      format: String(template.format ?? "html"),
      subject: rendered.subject ?? null,
      preheader: rendered.preheader ?? null,
      body_text: rendered.bodyMd,
      word_count: rendered.wordCount,
      would_send: check.ok,
      hard_fails: check.hardFails,
      soft_fails: check.softFails,
      // Gmail clips past 102KB, so the number matters more than the markup does.
      html_kb: html ? Math.round((html.length / 1024) * 10) / 10 : null,
      html: args.include_html === true ? html ?? null : null,
    };
  },
});

// ── setup grooming ────────────────────────────────────────────────────────────

/** The stage ladder a product's templates are measured against. */
const TEMPLATE_LADDER = [
  { key: "welcome", when: "the moment they arrive" },
  { key: "activation_nudge", when: "day two, if they have not activated" },
  { key: "value_proof", when: "day four, still cold" },
  { key: "objection", when: "day seven, stalled" },
  { key: "last_call", when: "day twelve, trial ending" },
];

TOOLS.push({
  name: "setup_gaps",
  description:
    "What this product still needs before it can work, split into what you can finish yourself and what only a person can supply. Read-only.",
  inputSchema: {
    type: "object",
    properties: { product_id: { type: "string" } },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const productId = await assertProduct(String(args.product_id), ctx);
    const db = await getDb();
    const s = { orgId: ctx.orgId, productId };

    const [templates, goals, sources, channels, brandSources, kit] = await Promise.all([
      db.collection(C.templates).find(s).project({ key: 1, channel: 1, status: 1, createdAt: 1 }).toArray(),
      db.collection(C.goals).find(s).toArray(),
      db.collection(C.sources).countDocuments({ ...s, enabled: true }),
      db.collection(C.channels).countDocuments({ ...s, enabled: true }),
      db.collection(C.brandSources).countDocuments(s),
      db.collection(C.brandKits).findOne(s),
    ]);

    const haveKeys = new Set(templates.map((t) => String(t.key)));
    const missingTemplates = TEMPLATE_LADDER.filter((rung) => !haveKeys.has(rung.key));
    const branded = Object.keys((kit?.provenance ?? {}) as object).length > 0;

    // Two piles, because they need two different responses: one is work, the other is a
    // request. Mixing them produces a routine that nags about what it should have done.
    const yours: Array<Record<string, string>> = [];
    const theirs: Array<Record<string, string>> = [];

    for (const rung of missingTemplates) {
      yours.push({
        gap: "missing_template",
        key: rung.key,
        detail: `No template for ${rung.key} — ${rung.when}.`,
        fix: "upsert_template with status draft",
      });
    }
    for (const goal of goals.filter((g) => !((g.checks ?? []) as unknown[]).length)) {
      yours.push({
        gap: "campaign_without_checks",
        key: String(goal.key),
        detail: `Campaign "${String(goal.name ?? goal.key)}" cannot tell whether anyone succeeded.`,
        fix: "verifiers then set_checks",
      });
    }

    if (!branded) {
      theirs.push({
        gap: "no_brand",
        detail: brandSources
          ? "A brand source exists but resolved nothing usable."
          : "No brand kit, so every email goes out unstyled.",
        fix: "Read the product website on the Brand page, or connect a brand provider.",
      });
    }
    if (sources === 0) {
      theirs.push({ gap: "no_source", detail: "No lead source, so nobody ever enters a campaign.", fix: "Upload a spreadsheet or connect a source." });
    }
    if (channels === 0) {
      theirs.push({ gap: "no_channel", detail: "No channel can send, so nothing leaves the building.", fix: "Connect SMTP or a sending provider." });
    }

    // A draft is fine on the day it is written and a question a week later. A campaign
    // with no createdAt predates drafting and is left alone rather than guessed about.
    const stale = goals.filter(
      (g) =>
        g.enabled === false &&
        g.createdAt instanceof Date &&
        Date.now() - g.createdAt.getTime() > 5 * 86_400_000,
    );
    if (stale.length) {
      theirs.push({
        gap: "campaigns_never_started",
        detail: `${stale.length} campaign${stale.length === 1 ? "" : "s"} drafted but never turned on: ${stale.map((g) => String(g.name ?? g.key)).join(", ")}.`,
        fix: "Review and activate them, or delete them.",
      });
    }

    return {
      product_id: productId,
      branded,
      counts: { templates: templates.length, campaigns: goals.length, sources, channels },
      ladder_covered: TEMPLATE_LADDER.filter((r) => haveKeys.has(r.key)).map((r) => r.key),
      // What you can do now.
      yours,
      // What only a person can supply.
      theirs,
      gaps: yours.length + theirs.length,
    };
  },
});

TOOLS.push({
  name: "notify_owner",
  description:
    "Raise one notification for the person who owns this product, for something only they can do. Repeats collapse into the existing unread row rather than stacking, so saying the same thing daily is harmless — and pointless.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      key: { type: "string", description: "Stable identifier for this concern, e.g. \"setup:no_source\"." },
      title: { type: "string" },
      body: { type: "string", description: "One short paragraph. Say what is blocked and what would unblock it." },
      href: { type: "string", description: "Where in the console they should land." },
    },
    required: ["product_id", "key", "title", "body"],
  },
  async handler(args, ctx) {
    const productId = await assertProduct(String(args.product_id), ctx);
    const { notify } = await import("../../engine/notify.js");
    const db = await getDb();
    const key = `groom:${String(args.key)}`;

    // Whether this is new is worth telling the caller: a routine that learns it already
    // asked has no reason to spend a run rephrasing the same request.
    const existing = await db
      .collection(C.notifications)
      .findOne({ orgId: ctx.orgId, productId, dedupeKey: key, readAt: null });

    await notify({
      orgId: ctx.orgId,
      productId,
      severity: "action",
      title: String(args.title),
      body: String(args.body),
      href: str(args.href),
      dedupeKey: key,
    });

    return {
      raised: !existing,
      dedupe_key: key,
      note: existing
        ? "already standing, unread — collapsed into the existing row"
        : "notification raised",
    };
  },
});

// ── creating a product ────────────────────────────────────────────────────────

TOOLS.push({
  name: "add_product",
  description:
    "Create a product from what you read on its website, and lay the groundwork: it reads the brand off the same site and writes the deterministic starter templates. Follow it with upsert_template to improve those and draft_campaign to propose campaigns. Read the site before calling this — a config guessed without reading is worse than no config.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      slug: { type: "string", description: "Lower-case, hyphenated. Derived from the name if omitted." },
      website: { type: "string" },
      one_liner: { type: "string", description: "What it does, in the words the site uses." },
      value_props: { type: "array", items: { type: "string" }, description: "Two to four. Concrete, not adjectives." },
      activation: {
        type: "object",
        description: "What counts as activated — behaviour, not signup. An inactive trial converts far worse.",
        properties: {
          described_as: { type: "string" },
          events: { type: "array", items: { type: "string" } },
        },
        required: ["described_as"],
      },
      segments: {
        type: "array",
        description: "Only those the page actually supports. Two real ones beat five invented.",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            name: { type: "string" },
            detect: { type: "string", description: "How to recognise this person from enrichment." },
            use_case: { type: "string" },
            pain: { type: "string" },
            objections: { type: "array", items: { type: "string" } },
            preferred_channels: { type: "array", items: { type: "string" } },
          },
          required: ["key", "name", "detect", "use_case", "pain"],
        },
      },
      voice: {
        type: "object",
        properties: {
          tone: { type: "string" },
          do: { type: "array", items: { type: "string" } },
          dont: { type: "array", items: { type: "string" } },
          reading_level: { type: "number" },
        },
        required: ["tone"],
      },
      forbidden_claims: { type: "array", items: { type: "string" }, description: "Anything the product cannot back up." },
      trial_link: { type: "string", description: "Where a message sends someone. {{person_id}} is substituted." },
    },
    required: ["name", "website", "one_liner", "value_props", "activation", "voice"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const { productConfig } = await import("../../schemas/product.js");
    const { generateDefaultTemplates } = await import("../../engine/templates.js");

    const name = String(args.name);
    const slug =
      (str(args.slug) ?? name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "product";

    const existing = await db.collection(C.products).findOne({ orgId: ctx.orgId, slug });
    if (existing) throw new Error(`a product with slug "${slug}" already exists — edit it rather than adding a second`);

    const segments = ((args.segments ?? []) as Array<Record<string, unknown>>).map((segment) => ({
      key: String(segment.key),
      name: String(segment.name),
      detect: String(segment.detect),
      useCase: String(segment.use_case),
      pain: String(segment.pain),
      objections: (segment.objections ?? []) as string[],
      preferredChannels: ((segment.preferred_channels ?? ["email"]) as string[]),
    }));
    const voice = args.voice as Record<string, unknown>;
    const activation = args.activation as Record<string, unknown>;
    const website = String(args.website).replace(/\/$/, "");

    // Parsed here so a malformed config fails at the tool boundary, with the field named,
    // rather than three days later inside a renderer.
    const config = productConfig.parse({
      website,
      oneLiner: String(args.one_liner),
      valueProps: args.value_props,
      segments,
      activation: { describedAs: String(activation.described_as), events: (activation.events ?? []) as string[] },
      voice: {
        tone: String(voice.tone),
        do: (voice.do ?? []) as string[],
        dont: (voice.dont ?? []) as string[],
        readingLevel: typeof voice.reading_level === "number" ? voice.reading_level : 8,
      },
      constraints: { forbiddenClaims: (args.forbidden_claims ?? []) as string[] },
      suggestedChannels: [{ key: "email", why: "Everyone has one, and it carries a real message.", priority: 1 }],
      trialLinkTemplate: str(args.trial_link) ?? `${website}/start?p={{person_id}}`,
    });

    const productId = new ObjectId();
    await db.collection(C.products).insertOne({
      _id: productId,
      orgId: ctx.orgId,
      slug,
      name,
      config,
      version: 1,
      status: "active",
      createdAt: new Date(),
    });

    // Brand and starter templates come free with the website. Neither is allowed to fail
    // the creation: a product with no brand is plainer mail, not a broken product.
    let branded = false;
    try {
      const { ensureWebsiteBrandSource, refreshBrandSource } = await import("../../engine/brand.js");
      await ensureWebsiteBrandSource(ctx.orgId, String(productId));
      const source = await db
        .collection(C.brandSources)
        .findOne({ orgId: ctx.orgId, productId: String(productId), kind: "css_vars" });
      if (source) {
        await refreshBrandSource(String(source._id));
        branded = true;
      }
    } catch {
      // Recorded on the brand source itself; the Brand page shows why.
    }

    const templates = await generateDefaultTemplates(ctx.orgId, String(productId), config);

    return {
      product_id: String(productId),
      slug,
      segments: segments.length,
      brand_read: branded,
      starter_templates: templates,
      next: [
        "get_brand, then upsert_template for the rest of the ladder — activation_nudge, value_proof, objection, last_call.",
        "draft_campaign for four or five campaigns that suit this product.",
        "setup_gaps to see what is left, then tell the person what is waiting on them.",
      ],
    };
  },
});

TOOLS.push({
  name: "draft_campaign",
  description:
    "Propose a campaign. It is created switched off, with whatever it still needs recorded on it, and never starts sending on its own — a person turns it on. Its verification plan is written later by the Plan routine.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      name: { type: "string" },
      success_described: { type: "string", description: "What done looks like, in plain words. Behaviour, not signup." },
      first_touch_template: { type: "string", description: "A template key that exists — welcome, activation_nudge, and so on." },
      primary_channel: { type: "string", description: "Defaults to email." },
      touches: { type: "number", description: "Whole budget, not a cautious fraction. Defaults to 9." },
      days: { type: "number", description: "Defaults to 30." },
      min_icp_fit: { type: "number", description: "0 to 1. Defaults to 0 — everyone." },
      rationale: { type: "string", description: "Why this campaign is worth running for this product." },
    },
    required: ["product_id", "name", "success_described", "first_touch_template"],
  },
  async handler(args, ctx) {
    const productId = await assertProduct(String(args.product_id), ctx);
    const db = await getDb();

    const name = String(args.name);
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!key) throw new Error("give the campaign a name that reduces to a key");

    const templateKey = String(args.first_touch_template);
    const template = await db.collection(C.templates).findOne({ orgId: ctx.orgId, productId, key: templateKey });
    if (!template) throw new Error(`no template with key "${templateKey}" — write it with upsert_template first`);

    const channel = str(args.primary_channel) ?? "email";
    const [sources, channels] = await Promise.all([
      db.collection(C.sources).countDocuments({ orgId: ctx.orgId, productId, enabled: true }),
      db.collection(C.channels).countDocuments({ orgId: ctx.orgId, productId, enabled: true, key: channel }),
    ]);

    // Recorded on the campaign rather than left implicit, so the console can say what it
    // is waiting for instead of showing a campaign that simply never does anything.
    const needs: string[] = [];
    if (sources === 0) needs.push("a lead source — nobody enters this campaign without one");
    if (channels === 0) needs.push(`a working ${channel} channel — nothing can be sent`);
    needs.push("a review, then switch it on");

    await db.collection(C.goals).updateOne(
      { orgId: ctx.orgId, productId, key },
      {
        $set: {
          orgId: ctx.orgId,
          productId,
          key,
          name,
          entry: { expression: "lead_created", minIcpFit: Number(args.min_icp_fit ?? 0) },
          success: { expression: "account_created", describedAs: String(args.success_described) },
          failure: { conditions: ["unsubscribe", "hard_bounce", "explicit_no"], silenceDays: 30 },
          budget: { touches: Number(args.touches ?? 9), days: Number(args.days ?? 30), usd: 12 },
          allowedChannels: [channel],
          checks: [],
          needsVerificationPlan: true,
          firstTouch: { templateKey, channels: [channel] },
          schedule: { fetchEverySec: 600, tickEverySec: 600, bufferDepth: 3, approvalMode: "gate_on" },
          cadenceByTemp: {
            hot: { minGapDays: 2, maxGapDays: 4, maxAssetTier: "C" },
            warm: { minGapDays: 2, maxGapDays: 3, maxAssetTier: "C" },
            cold: { minGapDays: 1, maxGapDays: 2, maxAssetTier: "C" },
            dead: { minGapDays: 999, maxGapDays: 999, maxAssetTier: "A" },
          },
          sourceIds: [],
          // Off. A campaign that starts sending because a scheduled session decided it
          // was ready is the worst surprise this system could produce.
          enabled: false,
          needs,
          rationale: str(args.rationale),
        },
        $setOnInsert: { _id: new ObjectId(), createdAt: new Date() },
      },
      { upsert: true },
    );

    return { key, name, enabled: false, needs };
  },
});

/**
 * Where research is written down.
 *
 * Without this, everything a session learns about a person survives only as prose inside
 * belief.reasoning — readable by a human, comparable by nothing. The next run starts from
 * the same blank page and cannot tell what has changed since, which is the whole point of
 * looking again.
 */
TOOLS.push({
  name: "save_enrichment",
  description:
    "Store what you found out about a person from outside the system — company, size, role, hiring, funding, anything researched. Facts as fields, not a paragraph: a later run compares against these to see what moved. Call it even when nothing changed and omit facts, so the person is not looked up again tomorrow.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      person_id: { type: "string" },
      facts: {
        type: "object",
        description:
          "Merged over what is already stored. Omit entirely to record that you checked and found nothing new.",
        additionalProperties: true,
      },
      source: {
        type: "string",
        description: "Where it came from: company_site, search, reply, human, or a provider name.",
      },
    },
    required: ["product_id", "person_id", "source"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const filter = { _id: new ObjectId(String(args.person_id)), orgId, productId };

    const person = await db.collection(C.people).findOne(filter, { projection: { enrichment: 1 } });
    if (!person) throw new Error("person not found");

    const now = new Date();
    const incoming = (args.facts ?? null) as Record<string, unknown> | null;
    const set: Record<string, unknown> = { lastEnrichedAt: now };

    if (incoming && Object.keys(incoming).length > 0) {
      // Merged rather than replaced. A run that only checked one thing must not erase what
      // an earlier, broader run found.
      const existing = (person.enrichment ?? {}) as Record<string, unknown>;
      set.enrichment = { ...existing, ...incoming, _source: String(args.source), _at: now };
    }

    await db.collection(C.people).updateOne(filter, {
      $set: set,
      $inc: { "investment.enrichmentCalls": 1 },
    });

    return {
      person_id: String(args.person_id),
      stored: incoming ? Object.keys(incoming) : [],
      last_enriched_at: now.toISOString(),
      note: incoming
        ? "Merged. lead_card returns the whole picture on the next read."
        : "Nothing changed; the clock was stamped so this person is not re-checked tomorrow.",
    };
  },
});

/**
 * What the planner reads before it writes a sequence.
 *
 * The counts are deliberately raw rather than a ranking. With forty leads there is no
 * statistical power for a bandit, but "twelve sent, five clicked, two won" against "thirty
 * sent, nothing" is a judgement a reader makes correctly in a second — and can explain
 * afterwards, which a posterior distribution cannot.
 *
 * Rates are over trackable sends, never over all of them. A message that could not report
 * a click is not evidence that the angle failed.
 */
TOOLS.push({
  name: "what_works",
  description:
    "What has actually worked for this product: every segment and angle with what it was sent to, what came back and what converted, plus the cross-product timing priors. Read this before plan_goal. An angle with few sends is untested, not losing — say so rather than abandoning it.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      segment: { type: "string", description: "Narrow to one segment. Omit for all of them." },
    },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const segment = args.segment ? String(args.segment) : undefined;

    const [angles, priors] = await Promise.all([anglePerformance(orgId, productId, segment), summarisePriors()]);

    const totalSent = angles.reduce((n, a) => n + a.sent, 0);
    const totalTrackable = angles.reduce((n, a) => n + a.trackable, 0);

    return {
      angles: angles.map((a) => ({
        ...a,
        // Null rather than zero where nothing could report. Zero reads as "nobody clicked",
        // which is a different and much stronger claim.
        click_rate: a.trackable > 0 ? Number((a.clicked / a.trackable).toFixed(3)) : null,
        win_rate: a.sent > 0 ? Number((a.won / a.sent).toFixed(3)) : null,
        verdict:
          a.sent < MIN_SAMPLE
            ? "untested"
            : a.won > 0
              ? "working"
              : a.clicked > 0
                ? "interest, no conversion"
                : "no signal",
      })),
      // Shared across products and carrying nothing that identifies one: hours and step
      // positions only. It is what a product with no history of its own starts from.
      timing_priors: priors,
      totals: {
        sent: totalSent,
        trackable: totalTrackable,
        untracked: totalSent - totalTrackable,
      },
      note:
        totalSent === 0
          ? "This product has sent nothing yet. Its own table is empty, so start from timing_priors — the hours and step positions that work across products — and treat every angle as untested."
          : totalTrackable === 0
            ? "Nothing sent so far could report a click. Silence here says nothing about any angle — plan on judgement, and check that APP_URL is set."
            : "Rates are over trackable sends only. Spend the budget on what has won; keep trying what is merely untested.",
    };
  },
});

/**
 * Where a reply becomes something the system knows.
 *
 * Monitor's prompt has always told it to call this, and until now the tool did not exist —
 * so replies reached a person's inbox, were read by a session, and vanished. They are the
 * strongest signal anyone ever sends us and the only one that arrives in words.
 *
 * The boundary with mark_state is deliberate: this records what was said and attributes it
 * to the message that provoked it. What it means for the campaign — succeeded, failed,
 * still running — stays with mark_state, which is gated on evidence. The exception is an
 * unsubscribe, which is not a judgement call.
 */
TOOLS.push({
  name: "record_reply",
  description:
    "Record that a person replied, what they said and what it means. Attributes the reply to the message it answers, so what_works can tell an angle that started a conversation from one that was ignored. Recording is not deciding: use mark_state for the campaign's verdict. An intent of unsubscribe suppresses them immediately and permanently.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      person_id: { type: "string" },
      text: {
        type: "string",
        description: "What they actually wrote, verbatim. Not your summary of it — a later run reads this.",
      },
      intent: {
        type: "string",
        enum: ["interested", "question", "objection", "not_now", "no", "wrong_person", "unsubscribe"],
      },
      objection: {
        type: "string",
        description: "The objection in one line, if there is one. Kept on the person and carried into every later campaign.",
      },
      answer: {
        type: "string",
        description: "What you are replying, grounded in what the product actually does. Never invent a capability to close someone.",
      },
      event_id: { type: "string", description: "The replies_waiting id from sweep, so it stops being returned." },
      at: { type: "string", description: "When they replied, ISO 8601. Defaults to now." },
    },
    required: ["product_id", "person_id", "text", "intent"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const personId = String(args.person_id);
    const person = await db
      .collection(C.people)
      .findOne({ _id: new ObjectId(personId), orgId, productId }, { projection: { primaryEmail: 1 } });
    if (!person) throw new Error("person not found");

    const at = args.at ? new Date(String(args.at)) : new Date();
    const intent = String(args.intent);
    const actionId = await attributeReply(orgId, productId, personId, at);

    await db.collection(C.people).updateOne({ _id: new ObjectId(personId) }, { $set: { lastSignalAt: at } });

    // Sends them to the front of the recompute queue. Guarded on temp already existing:
    // a dotted $set against a person who has never been classified would mint a temp with
    // a timestamp and no band, and every reader of that field expects a band.
    if (intent !== "no" && intent !== "unsubscribe") {
      await db
        .collection(C.people)
        .updateOne(
          { _id: new ObjectId(personId), temp: { $exists: true } },
          { $set: { "temp.computedAt": new Date(0) } },
        );
    }

    if (args.objection) {
      await db.collection(C.people).updateOne(
        { _id: new ObjectId(personId) },
        { $push: { objections: { text: String(args.objection), at, source: "reply" } } as never },
      );
    }

    // Not a verdict and not negotiable. Someone who asks to be left alone is suppressed
    // before anything else reads their record.
    let suppressed = false;
    if (intent === "unsubscribe" && person.primaryEmail) {
      await suppress(orgId, String(person.primaryEmail), "unsubscribed by reply");
      await db.collection(C.people).updateOne(
        { _id: new ObjectId(personId) },
        {
          $set: {
            lifecycle: "suppressed",
            suppressedAt: at,
            "consent.state": "withdrawn",
            "consent.capturedAt": at,
            "consent.evidence": "reply: unsubscribe",
          },
        },
      );
      await db
        .collection(C.goalInstances)
        .updateMany(
          { orgId, productId, personId, status: "active" },
          { $set: { status: "failed", outcome: "unsubscribed", endedAt: at } },
        );
      await db.collection(C.actions).updateMany(
        { orgId, productId, personId, status: { $in: ["queued", "awaiting_approval", "held"] } },
        { $set: { status: "skipped", skipReason: "unsubscribed" } },
      );
      suppressed = true;
    }

    // The words themselves, kept whole. Everything above is derived from them, and a later
    // reader disagreeing with the reading needs the original to disagree with.
    await db.collection(C.events).insertOne({
      orgId,
      productId,
      personId,
      type: "reply_recorded",
      ts: at,
      payload: {
        intent,
        text: String(args.text),
        answer: args.answer ? String(args.answer) : null,
        actionId,
      },
    });

    if (args.event_id && ObjectId.isValid(String(args.event_id))) {
      await db
        .collection(C.events)
        .updateOne({ _id: new ObjectId(String(args.event_id)), orgId }, { $set: { handled: true, handledAt: at } });
    }

    return {
      person_id: personId,
      intent,
      attributed_to_action: actionId,
      suppressed,
      note: actionId
        ? "Attributed to their most recent send, so the angle that started this conversation gets the credit."
        : "No unanswered send to attribute this to — recorded against the person only.",
    };
  },
});
