import { ObjectId } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
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

        const lowBuffers = [];
        for (const goal of wants("compose") ? activeGoals : []) {
          if (!goal.currentPlanId) continue;
          const queued = await db
            .collection(C.actions)
            .countDocuments({ ...s, goalInstanceId: String(goal._id), status: "queued" });
          if (queued < 2) lowBuffers.push({ goal_instance_id: String(goal._id), queued });
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
          p.verification_looks_wrong.length,
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
      "Store the belief you formed about one or more people: segment, confidence, pain hypothesis, likely objections, ICP fit. Clears their needs-classification flag.",
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
                intentScore: 0,
                reasoning: String(r.reasoning),
                source: "system",
                updatedAt: new Date(),
              },
              // Fit is known before any engagement, so temperature starts from fit alone.
              temp: {
                score: Math.round(icpFit * 40),
                band: icpFit >= 0.7 ? "warm" : "cold",
                computedAt: new Date(),
                termsUsed: ["fit"],
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
      "Write the pipeline for one person: the ordered steps, each with channel, angle, timing and why. Every channel must be one the campaign allows — lead_card lists what is connected and what each can carry. Stored as a new version; the previous plan is kept with your rationale for replacing it.",
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
            // Composed copy, so the renderer uses this instead of the template fallback.
            content: {
              subject: t.subject ? String(t.subject) : undefined,
              bodyMd: body,
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
          results.push({ source_id: id, ...(await runSource(id)) });
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

    await db.collection(C.goals).updateOne(
      { orgId, productId, key: String(args.goal_key) },
      {
        $set: {
          checks: checks.map((c) => ({ ...c, args: c.args ?? {}, latch: c.latch ?? true, proposedBy: "claude" })),
          needsVerificationPlan: false,
          checksWrittenAt: new Date(),
        },
      },
    );
    return { goal_key: String(args.goal_key), checks: checks.length };
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
        const client = new McpClient(String(connection.serverUrl), token);

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
    "Set the outcome for people in active campaigns after reading their probe results. Use 'succeeded' only when the raw response actually supports it; 'failed' only for a real ending, not for a check that has simply not passed yet; 'continue' to leave a campaign running with a note about where the person is.",
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
