import { ObjectId } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { anglePerformance, anglesTriedOn, assetPerformance, attributeReply, bumpPrior, evidenceStatus, explorationBlock, ideaPerformance, MIN_SAMPLE, spentAngles, stampGoalOutcome, summarisePriors, themePerformance } from "../../engine/outcomes.js";
import { greetingName } from "../../engine/names.js";
import { planViewFor } from "../../engine/planView.js";
import { renderTemplate as renderForCount } from "../../engine/compose.js";
import { mergeVarsFor as varsForCount } from "../../engine/vars.js";
import { WRITTEN_MESSAGE_MAX_WORDS, WRITTEN_QUESTION_MAX_WORDS, takesWrittenWords, writtenParamsOf, writtenTemplatesFor } from "../../engine/engineSteps.js";
import { readableWords } from "../../engine/validate.js";
import { allowedSegments, stampPlaybook } from "../../engine/playbooks.js";
import { PRIORITY, THINKING_KINDS, claimBatch, completeAll, releaseAll, type ThinkingKind } from "../../engine/queue.js";
import { backlog } from "../../engine/dispatch.js";
import { dueAtFor, type CadenceBand } from "../../engine/cadence.js";
import { suppress } from "../../engine/suppression.js";
import { addressFor } from "../../engine/address.js";
import { allowedMailboxIds, mailboxFilter } from "../../engine/channels.js";
import { activeInstanceFor } from "../../engine/instances.js";
import { runSource, dueSources } from "../../engine/runSource.js";
import { fireDue, rungsSentTo } from "../../engine/fireDue.js";
import { planMenuFor } from "../../engine/templates.js";
import { writingBriefFor } from "../../engine/writingBrief.js";
import { CONTEXT_REFRESH_DAYS, READ_BATCH_MAX, contextAgeDays, contextOf, kindFromPath, normalisePageUrl, onSite, readPages, siteMap } from "../../engine/siteContext.js";
import { siteContext, SITE_PAGE_KINDS } from "../../schemas/product.js";
import { TRIAL_LEADS, TRIAL_OPEN_MAX, ideaLeadCount, ideaLimitsFor, ideaUsage, ideasFor, ideasHadBy, ideasLoopOn, ideasOf, inventedOf, nextInventedN, reviewInventedIdeas, type InventedIdea } from "../../engine/ideas.js";
import { COST_LABEL_MAX_CHARS, FRAME_BODY_MAX_WORDS, OPENING_MAX_CHARS, ROLLING_MAX_STEPS, SCAN_LINE_MAX_CHARS, avoidedWord, companyTokens, CTA_TEXTS, screenWords, unsampledFigures, paceBand, clickedRecently, RECEIPT_LINE_MAX_CHARS, RECEIPT_MAX_LINES, unprovenClaims, emojiProneSymbols, frameKeyOf, LEAD_TYPE_PROFILES, leadTypeOf, longSentences, SENTENCE_MAX_WORDS, groupFor, isRolling, isRollingPlan, layoutArm, spelledQuantities, themeSlug, unlabelledNumbers, watchWindowMs, type LayoutTest } from "../../engine/rolling.js";
import { reconcileDispatched } from "../../engine/reconcile.js";
import { resolveChannelAdapter } from "../../engine/adapters.js";
import { registerRoutine, routineHealth } from "../../engine/routines.js";
import { listRuns, sumCounters, ROUTINE_KEYS, type RoutineKey } from "../../engine/runlog.js";
import { MAX_ASSET_FILE_BYTES, readAssetFile } from "../../engine/assetFiles.js";
import {
  accessUnlocked,
  assetContextFrom,
  assetContextFor,
  segmentObjectionsFor,
  assetMenuFor,
  assetRefusals,
  loadAssets,
} from "../../engine/assets.js";
import { LINKEDIN_TOOLS } from "./linkedinTools.js";
import { crmForPerson, crmForPlanner } from "../../engine/crm/view.js";
import { salesChatForPlanner } from "../../engine/whatsappInbound.js";
import { saidText, sinceLastPlan } from "../../engine/news.js";

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
  /** The MCP session this call arrived on, where the client names one. Runs are scoped to it. */
  sessionId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}

/**
 * A result made of MCP content blocks rather than JSON — how a tool shows the model a
 * picture. `logged` is what the run log keeps instead, because the image itself is megabytes
 * of base64 that no person reading a run could look at.
 */
export interface MediaResult {
  media: true;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  logged: Record<string, unknown>;
}

export function isMediaResult(value: unknown): value is MediaResult {
  return typeof value === "object" && value !== null && (value as { media?: unknown }).media === true && Array.isArray((value as { content?: unknown }).content);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * The call-to-action a writer added to copy that is going to be wrapped in a template that
 * already has one, or null when the copy leaves that to the skeleton.
 *
 * Matches the link by shape rather than by the product's own domain: what makes it a
 * duplicate is that it is the start link for this person — `{{trial_link}}`, a URL carrying
 * `{{person_id}}`, or one where the id has already been resolved into it. A resolved id is
 * the worse of the two: copy carrying one person's id is copy that cannot be reused for
 * anyone else without mailing them a stranger's link.
 */
function signOffLink(body: string): string | null {
  const patterns = [
    /\{\{\s*trial_link\s*\}\}/,
    /https?:\/\/\S*\{\{\s*person_id\s*\}\}/,
    /https?:\/\/\S*[?&]p=[0-9a-f]{24}/i,
    /https?:\/\/\S*\/(?:start|signup|trial)\b\S*/i,
  ];
  for (const pattern of patterns) {
    const hit = body.match(pattern);
    if (hit) return hit[0].slice(0, 80);
  }
  return null;
}

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
  // Returns the ORG id, and every caller reads it as such: `const orgId = await
  // assertProduct(productId, ctx)`. A handler that wrote `const productId = await
  // assertProduct(...)` was filing templates, brand reads and previews under the org id;
  // those five handlers are fixed at their own lines. Changing this return to the product
  // id instead, as was tried once, made every other tool look people up under the wrong
  // org — "person not found" on each lead_card, and a whole Advance run composing nothing.
  return ctx.orgId;
}

/**
 * One person's whole response, in the shape a session reads before writing to them.
 *
 * Machine fetches are counted separately and named rather than dropped, so a session that
 * reads the raw touch list and sees a timestamp seconds after the send has the explanation
 * on the same object instead of inferring interest from a scanner.
 */
/** Sent, opened and clicked per format, people only: a gateway scan is not a reader. */
function engagementByFormat(actions: Array<Record<string, unknown>>): Record<string, { sent: number; opened: number; clicked: number }> {
  const out: Record<string, { sent: number; opened: number; clicked: number }> = {};
  for (const a of actions) {
    if (a.channel !== "email" || !["sent", "dispatched"].includes(String(a.status))) continue;
    const key = String(a.format ?? "template");
    const row = (out[key] ??= { sent: 0, opened: 0, clicked: 0 });
    const signals = (a.signals ?? []) as Array<{ type?: string; bot?: unknown }>;
    const human = (type: string, stamp: unknown) =>
      signals.length ? signals.some((sig) => sig.type === type && !sig.bot) : Boolean(stamp);
    row.sent++;
    if (human("opened", a.firstOpenedAt)) row.opened++;
    if (human("clicked", a.firstClickedAt)) row.clicked++;
  }
  return out;
}

function engagementOf(
  actions: Array<Record<string, unknown>>,
  events: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const sent = actions.filter((a) => ["sent", "dispatched"].includes(String(a.status)));
  const clicked = sent.filter((a) => a.firstClickedAt);
  const opened = sent.filter((a) => a.firstOpenedAt);
  const replies = events.filter((e) => String(e.type) === "reply_received");
  const last = <T,>(rows: T[], pick: (row: T) => unknown): unknown =>
    rows
      .map(pick)
      .filter(Boolean)
      .sort((a, b) => new Date(String(b)).getTime() - new Date(String(a)).getTime())[0] ?? null;

  return {
    sent: sent.length,
    clicked: clicked.length,
    opened: opened.length,
    replied: replies.length,
    last_clicked_at: last(clicked, (a) => a.firstClickedAt),
    last_replied_at: last(replies, (e) => e.ts),
    // Opens are only measured where consent allowed a pixel, which is rarely. Zero opens
    // with nothing trackable means nothing was measured, and must not be read as silence.
    opens_measured: sent.some((a) => (a.tracking as { opens?: boolean } | undefined)?.opens === true),
    machine_filtered: sent.filter((a) => a.firstMachineClickedAt ?? a.firstMachineOpenedAt).length,
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_products",
    description: "Every product this token can act on, with its goals and how much work is waiting.",
    inputSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      const db = await getDb();
      const products = await db.collection(C.products).find({ orgId: ctx.orgId, status: "active" }).toArray();
      const rows = await Promise.all(
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
      // Wrapped, because a bare array is not a valid `structuredContent` — the protocol
      // requires an object, and a client that validates the response rejects the call
      // outright. This tool is available to every routine, so the failure was one a
      // scheduled session could hit on its opening call and spend the hour recovering from.
      return { products: rows };
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
          enum: ["all", "acquire", "advance", "react", "close", "maintain", "monitor", "plan", "compose"],
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

      // The sections predate the routines that read them, and the routines were renamed
      // without this. A session calling sweep with its own name got an empty packet and a
      // prompt telling it that an empty packet means stop — so it stopped, having done
      // nothing, with no error anywhere. Silence again.
      const BY_ROUTINE: Record<string, string[]> = {
        acquire: ["plan"],
        advance: ["compose"],
        react: ["monitor"],
        close: ["monitor"],
        maintain: ["plan"],
      };
      const SECTIONS = ["plan", "compose", "monitor"];
      if (scope !== "all" && !BY_ROUTINE[scope] && !SECTIONS.includes(scope)) {
        throw new Error(
          `unknown scope "${scope}". Use one of: all, ${Object.keys(BY_ROUTINE).join(", ")}. ` +
            `Returning nothing for a scope nobody recognises would read as "no work", which is not the same answer.`,
        );
      }
      const sections = scope === "all" ? SECTIONS : (BY_ROUTINE[scope] ?? [scope]);
      const wants = (section: string) => sections.includes(section);
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
              // Oldest first, always. Without a sort this returned whatever the index handed
              // back, so the same rows were offered run after run while people who arrived
              // later were never reached.
              .sort({ createdAt: 1 })
              .limit(limit)
              .toArray()
          : [];

        // A goal instance with no plan has had its welcome and nothing since — that is the
        // gap a routine exists to close.
        //
        // Queried on the condition rather than filtered after a limit. The previous version
        // read the first two hundred active instances in natural order and then kept the
        // unplanned ones, so a product whose first two hundred rows were already planned
        // reported "nothing to do" while thousands waited behind them. There was no error
        // and no log line: the backlog was invisible precisely because it was large.
        // A campaign that sends one message has nothing left to plan once that message is
        // queued — a WhatsApp intro beside the email campaign, say — so its leads are not
        // offered for planning. The email campaign they are also in is.
        const oneMessage = wants("plan")
          ? (await db.collection(C.goals).find({ ...s, "budget.touches": { $lte: 1 } }).project({ key: 1 }).toArray()).map((g) => String(g.key))
          : [];
        const needPlan = wants("plan")
          ? await db
              .collection(C.goalInstances)
              .find({ ...s, status: "active", currentPlanId: { $exists: false }, goalKey: { $nin: oneMessage } })
              .sort({ startedAt: 1 })
              .limit(limit)
              .toArray()
          : [];

        const activeGoals = await db
          .collection(C.goalInstances)
          .find({ ...s, status: "active" })
          .sort({ lastReviewedAt: 1, startedAt: 1 })
          .limit(200)
          .toArray();

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
            note:
              g.verifyConnectionId
                ? "Call verifiers to see what this connection exposes, then set_checks. Until then this campaign cannot tell when anyone succeeds."
                : "No server was picked, which is an answer rather than an omission — this campaign's finish line is not in anybody's system. Write the checks against what this product can observe on its own: kind 'page' for a confirmation page on the customer's site, kind 'reply' for something the person states in words, kind 'human' where nothing can observe it. Until then this campaign cannot tell when anyone succeeds.",
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
      "Everything about one person in a single call: identity, enrichment, belief, temperature, their goal, every touch sent, and what came back — opens, clicks and the link they followed, with mail-gateway scans reported separately so they are never mistaken for interest. Also lists the assets that may be shown to this person right now, already filtered by their segment, temperature and what they have been sent. The list is what you are allowed to use, not what you have to use — most touches are words alone, and an asset is worth carrying only when it answers something this person actually raised. Never name one that is not on the list. When the product reads a sales CRM, `crm` shows what that team logged on this person, and `sales_whatsapp` what they and the person said on WhatsApp (both read-only context: build on it, do not repeat it, never mention it in a message). `since_last_plan` lists everything that happened after the current plan was written, from all of these at once: read it first, because a need or an offer there outranks the idea bank.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        person_id: { type: "string" },
        goal_instance_id: {
          type: "string",
          description:
            "The campaign to show, when the work item names one. A lead can be in several campaigns; without this the card shows the one being planned, and lists the others under other_campaigns.",
        },
      },
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

      const named = args.goal_instance_id
        ? await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(args.goal_instance_id)), orgId, productId, personId: String(person._id) })
        : null;
      const [goal, actions, events, product, openCampaigns] = await Promise.all([
        named ?? activeInstanceFor({ orgId, productId, personId: String(person._id) }),
        db
          .collection(C.actions)
          .find({ orgId, productId, personId: String(person._id) })
          .sort({ dueAt: 1 })
          .toArray(),
        db.collection(C.events).find({ orgId, personId: String(person._id) }).sort({ ts: -1 }).limit(50).toArray(),
        db.collection(C.products).findOne({ _id: new ObjectId(productId) }),
        db
          .collection(C.goalInstances)
          .find({ orgId, productId, personId: String(person._id), status: "active" })
          .project({ goalKey: 1, spent: 1, startedAt: 1 })
          .toArray(),
      ]);

      const goalDef = goal
        ? await db.collection(C.goals).findOne({ orgId, productId, key: String(goal.goalKey) })
        : null;

      // The menu of things we may show them, narrowed before the session sees it. Doing
      // this here rather than leaving it to the composer is what stops an expired case
      // study, a second copy of a video they already have, or a calendar link to somebody
      // who has never opened anything.
      const band = paceBand(person, goalDef);
      const assetsAvailable = await assetMenuFor(
        orgId,
        productId,
        assetContextFrom(person, actions, goalDef, segmentObjectionsFor(product, person)),
      );
      // The sales team's side, from our own copy of their CRM. Absent unless a CRM is being
      // read for this product and this person was found in it, so a card without it is the
      // card as it always was.
      const [crmView, salesWhatsapp] = await Promise.all([
        crmForPerson(orgId, productId, String(person._id)),
        salesChatForPlanner(orgId, productId, person),
      ]);
      const crm = crmForPlanner(crmView);
      // What happened since the current plan was written, from every source at once, so the
      // planner reads the news first instead of finding it at the end of three long lists.
      const currentPlan =
        goal?.currentPlanId && ObjectId.isValid(String(goal.currentPlanId))
          ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(goal.currentPlanId)) }, { projection: { createdAt: 1 } })
          : null;
      const since = goal
        ? sinceLastPlan({
            planWrittenAt: currentPlan?.createdAt,
            crm: crmView,
            salesChat: salesWhatsapp,
            actions: actions.filter((a) => String(a.goalInstanceId) === String(goal._id)),
            events,
          })
        : undefined;

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
        // The other campaigns this lead is in right now, so a plan here can see that a
        // WhatsApp intro, say, has already gone from another one. Their touches are in
        // `touches` with the rest.
        other_campaigns: openCampaigns
          .filter((c) => String(c._id) !== String(goal?._id ?? ""))
          .map((c) => ({ goal_instance_id: String(c._id), goal_key: c.goalKey, touches_sent: (c.spent as { touches?: number } | undefined)?.touches ?? 0 })),
        ...(since ? { since_last_plan: since } : {}),
        ...(crm ? { crm } : {}),
        ...(salesWhatsapp ? { sales_whatsapp: salesWhatsapp } : {}),
        goal: goal
          ? {
              goal_instance_id: String(goal._id),
              goal_key: goal.goalKey,
              /** What this campaign is and how to write for it, as a person described it. */
              brief: goalDef?.brief ?? null,
              spent: goal.spent,
              deadline: goal.deadline,
              budget: goalDef?.budget,
              success: goalDef?.success,
              cadence_by_temp: goalDef?.cadenceByTemp,
              // The plan as the engine reads it: each step's state, which one is next by
              // the same gates and rules advance() applies, and whether it is a session's
              // to write or the engine's to render. compose_batch refuses anything else.
              plan: await planViewFor(goal, actions.filter((a) => String(a.goalInstanceId) === String(goal._id)), band),
              // A campaign that plans a touch or two at a time. Read `writing` below before
              // planning or writing: the plan is short, each step is an idea in words, and the
              // message is written whole.
              rolling: isRolling(goalDef),
              // In a campaign that plans each lead: the emails this lead's plan is built
              // from, with what each says, whether they already had it, and how it has done.
              // In a rolling campaign these are only the fallback the engine sends when a plan
              // or its words never arrive; plan ideas of your own instead.
              plan_from: (goalDef?.perLeadPlan as { family?: string } | undefined)?.family
                ? await planMenuFor(
                    orgId,
                    productId,
                    String((goalDef?.perLeadPlan as { family: string }).family),
                    new Set(await rungsSentTo(String(person._id))),
                  )
                : null,
            }
          : null,
        /**
         * What may be shown to this person on the next touch, and nothing else.
         *
         * Each row carries the three sentences an asset is chosen on — when it applies,
         * what it proves, and how to introduce it — so the copy leading into an asset is
         * written knowing what it lands on rather than blind. Choose by asset_id.
         *
         * An empty list is not a problem to solve, and a full one is not a quota. Nothing
         * anywhere requires a touch to carry an asset: a sequence that attaches something
         * to every message is the one that stops meaning anything by the third.
         */
        assets_available: assetsAvailable,
        /**
         * In a rolling campaign: who they are in their own words, what the product can truly
         * say, what they already had and what came of it, and what worked for leads like them.
         */
        writing:
          goal && isRolling(goalDef)
            ? await writingBriefFor({
                orgId,
                productId,
                person,
                goal: goalDef,
                product,
                actions: actions.filter((a) => String(a.goalInstanceId) === String(goal._id)),
                goalInstanceId: String(goal._id),
                goalKey: String(goal.goalKey),
                said: saidText(crmView, salesWhatsapp),
              })
            : null,
        /**
         * Whether this person has earned a way to reach us: a calendar link, a phone
         * number, a named human. False until they click something, and separate from the
         * tier cap because handing over access is not the same decision as sending a heavy
         * asset.
         */
        access_unlocked: accessUnlocked(clickedRecently(person)),
        // Prior claims are supplied so the next message never repeats or contradicts one.
        //
        // And what each one earned. This card promised "every touch sent and what came
        // back" while returning only the sending half, so a session writing the next
        // message to someone who had clicked twice wrote it as though they had ignored
        // everything — the strongest thing known about that person was the one thing not
        // on the card.
        touches: actions.map((a) => ({
          action_id: String(a._id),
          channel: a.channel,
          angle: a.angle,
          status: a.status,
          sent_at: a.sentAt ?? null,
          subject: (a.content as { subject?: string })?.subject ?? null,
          format: a.format ?? (a.channel === "email" ? "template" : null),
          layout: a.layout ?? null,
          claims_made: (a.content as { claimsMade?: string[] })?.claimsMade ?? [],
          opened_at: a.firstOpenedAt ?? null,
          clicked_at: a.firstClickedAt ?? null,
          // Where they went, when the link recorded it. "Clicked the pricing page" is a
          // different opening line from "clicked something".
          clicked_url:
            ((a.signals ?? []) as Array<{ type?: string; url?: unknown; bot?: unknown }>).find(
              (sig) => sig.type === "clicked" && !sig.bot && sig.url,
            )?.url ?? null,
          // A mail security gateway walked the links seconds after the send. Reported so
          // that a message which looks engaged-with in the raw record is not mistaken for
          // interest — it is not one, and nothing should be written as though it were.
          machine_scanned_at: a.firstMachineClickedAt ?? a.firstMachineOpenedAt ?? null,
        })),
        // The same thing said once, so a session does not have to fold the touch list to
        // learn whether this person has ever responded at all.
        engagement: engagementOf(actions, events),
        // What this person did with each format we sent them, for the writer's format choice.
        engagement_by_format: engagementByFormat(actions),
        events: events.map((e) => ({ type: e.type, ts: e.ts, payload: e.payload })),
        // The writing brief travels in `writing` above, once, and only where it applies.
        product_config: product?.config ? { ...(product.config as Record<string, unknown>), writing: undefined, email: undefined } : null,
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
      const productId = String(args.product_id);
      await assertProduct(productId, ctx);
      const results = (args.results ?? []) as Array<Record<string, unknown>>;
      let updated = 0;
      let restamped = 0;

      // Refused rather than corrected, and refused for the whole batch before anything is
      // written. This product declares two segments and classification had invented
      // twenty-two, including `smb_owner_other`, `other_smb_owner` and
      // `smb_owner_services` as three separate buckets of twenty-seven, nine and three
      // people. Nothing can learn from buckets that size, and a playbook per accidental
      // bucket is a playbook nobody writes. A genuinely new segment is an edit to the
      // product config, which is a decision someone makes on purpose.
      const allowed = await allowedSegments(ctx.orgId, productId);
      const rejected = [...new Set(results.map((r) => String(r.segment)).filter((s) => !allowed.includes(s)))];
      if (rejected.length) {
        throw new Error(
          `unknown segment${rejected.length === 1 ? "" : "s"} ${rejected.join(", ")}. ` +
            `This product accepts: ${allowed.join(", ")}. Use "unknown" where there was nothing to read ` +
            `and "off_icp" where they are not a prospect; add a real new segment to the product config first.`,
        );
      }

      for (const r of results) {
        const icpFit = Number(r.icp_fit ?? 0);
        const fitKnown = r.fit_known !== false;
        const personId = String(r.person_id);
        const before = await db
          .collection(C.people)
          .findOne({ _id: new ObjectId(personId), orgId: ctx.orgId }, { projection: { belief: 1, arrivals: 1 } });
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
              // No temperature here: it comes from their campaign's lead type, which the
              // tick reads, not from fit.
              needsClassification: false,
            },
          },
        );
        updated++;

        // Reading somebody as a different segment is only useful if it changes what they
        // receive. The welcome has already gone out by now — it is queued within seconds of
        // arrival — so the stamp swaps the rest of the sequence for the one this segment
        // actually deserves, and declines to do it once enough messages have been sent that
        // a rewrite would contradict what they have already read.
        const wasSegment = (before?.belief as { segment?: string } | undefined)?.segment;
        if (wasSegment !== String(r.segment)) {
          // Every campaign they are in: each has its own playbook for the segment.
          const instances = await db
            .collection(C.goalInstances)
            .find({ orgId: ctx.orgId, productId, personId, status: "active" })
            .project({ _id: 1, goalKey: 1 })
            .toArray();
          for (const instance of instances) {
            const stamp = await stampPlaybook({
              orgId: ctx.orgId,
              productId,
              goalInstanceId: String(instance._id),
              goalKey: String(instance.goalKey),
              segmentKey: String(r.segment),
            });
            if (stamp.stamped) restamped++;
          }
        }
      }
      return { updated, restamped };
    },
  },

  {
    name: "plan_goal",
    description:
      "Write the pipeline for one person: the ordered steps, each with channel, angle, timing and why. Every channel must be one the campaign allows — lead_card lists what is connected and what each can carry. Around a third of the steps must use an angle that is not already proven for this segment, and a plan of three or more steps may not use one angle throughout; both are refused rather than warned about, because spending every step on the current favourite is how the untested angles never get the sends that would prove them. A step may name one asset_id from lead_card's assets_available, and most steps should name none — anything not on that list is refused, with the reason. Stored as a new version; the previous plan is kept with your rationale for replacing it. In a campaign that plans each lead (lead_card shows goal.plan_from), every step names one email from that list as template_key — never the family, never the welcome, never one they already had — and its why says what about this lead put it there. Messages still waiting from the plan it replaces are skipped, and step numbers already used on this lead are moved past; the stored step_ids come back.",
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
              asset_id: {
                type: "string",
                description:
                  "Optional. One of lead_card's assets_available, or omitted for a step that is words " +
                  "alone — which most steps are. Committing it here means the step still carries the " +
                  "right thing if it fires before anyone writes copy for it.",
              },
              why_asset: { type: "string", description: "What that asset answers for this person." },
              theme: {
                type: "string",
                description:
                  "Required in a campaign that plans a touch or two at a time (lead_card shows goal.rolling). " +
                  "The idea this touch is built on, in a few words a person reads: \"Evening calls to every manager\". " +
                  "Invent it for this lead. The angle is stored as its slug, so results are counted per idea.",
              },
              hook: { type: "string", description: "Optional. How the idea lands: story, rupee_math, question, comparison, proof, or your own word." },
              idea_refs: { type: "array", items: { type: "number" }, description: "The idea numbers from lead_card writing.ideas this step is built on. Required where the product's idea bank is tagged." },
              format: { type: "string", enum: ["text", "letter", "html"], description: "Optional intention; the writer decides at compose time." },
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

      // Refused before anything is read, let alone written. A plan once arrived with no
      // steps and a rationale of "undefined"; it was stored, the tool then crashed on the
      // reply, and every page that listed this person's plans crashed after it.
      const planSteps = Array.isArray(args.steps)
        ? (args.steps as Array<{ id?: unknown; asset_id?: unknown; channel?: unknown; angle?: unknown }>)
        : [];
      if (planSteps.length === 0) {
        throw new Error("A plan needs at least one step. Nothing was written.");
      }
      const rationale = typeof args.rationale === "string" ? args.rationale.trim() : "";
      if (!rationale || rationale === "undefined") {
        throw new Error("A plan needs a rationale in words. Nothing was written.");
      }

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
        const stray = planSteps.map((st) => String(st.channel)).filter((ch) => !allowed.includes(ch));
        if (stray.length > 0) {
          throw new Error(
            `This campaign may only use ${allowed.join(", ")}. The plan asks for ${[...new Set(stray)].join(", ")}.`,
          );
        }
      }

      // A campaign that plans a touch or two at a time. The plan is short on purpose: the engine
      // watches what this lead does with it and asks again. Each step is an idea in words,
      // stored under its slug as the angle, rendered through the campaign's frame.
      const rolling = isRolling(goalDef);
      const frameKey = frameKeyOf(goalDef);
      if (rolling) {
        if (planSteps.length > ROLLING_MAX_STEPS) {
          throw new Error(
            `This campaign plans ${ROLLING_MAX_STEPS} touches at a time and this plan has ${planSteps.length}. Plan the next one or two; ` +
              `the engine asks for the next plan once it has seen what this lead does with these. Nothing was written.`,
          );
        }
        const missing = (planSteps as Array<Record<string, unknown>>).filter((st) => !String(st.theme ?? "").trim());
        if (missing.length) {
          throw new Error(`step ${missing.map((st) => String(st.id)).join(", ")} has no theme. Each touch is built on one idea in words. Nothing was written.`);
        }
        for (const st of planSteps as Array<Record<string, unknown>>) {
          st.angle = themeSlug(String(st.theme));
          // Always the frame. A step that named one of the fixed feature emails got a single
          // opening line written into it, which is the old mail under a new label; the fixed
          // emails are only the engine's fallback here.
          st.template_key = frameKey;
          delete st.templateKey;
          if (st.format !== undefined && st.format !== "text" && st.format !== "html" && st.format !== "letter") delete st.format;
        }
        // Every step names the ideas it is built on, when the product's idea bank is tagged, and a
        // step whose ideas the campaign has already given to many leads this week is refused, so
        // the bank is used rather than the same few scenes.
        const productDocForIdeas = await db.collection(C.products).findOne({ _id: new ObjectId(String(instance.productId)) }, { projection: { "config.writing.ideas": 1, "config.writing.invented": 1 } });
        const bank = ideasFor(productDocForIdeas);
        if (bank.length) {
          const known = new Map(bank.map((idea) => [idea.n, idea]));
          const usage = await ideaUsage({ orgId: ctx.orgId, productId: String(instance.productId), goalKey: String(instance.goalKey), excludeInstanceId: String(instance._id) });
          const had = await ideasHadBy({ orgId: ctx.orgId, goalInstanceId: String(instance._id) });
          const { cap } = await ideaLimitsFor({ orgId: ctx.orgId, productId: String(instance.productId), goalKey: String(instance.goalKey), bank });
          for (const st of planSteps as Array<Record<string, unknown>>) {
            const refs = (Array.isArray(st.idea_refs) ? st.idea_refs : []).map(Number).filter((n) => Number.isFinite(n));
            if (refs.length === 0) {
              throw new Error(`step ${String(st.id)} names no idea. Pick from lead_card writing.ideas (best_fit first) and pass idea_refs, for example [16]. A new idea still names the ideas it came from. Nothing was written.`);
            }
            const unknown = refs.filter((n) => !known.has(n) || known.get(n)!.usable === false);
            if (unknown.length === refs.length) {
              throw new Error(`step ${String(st.id)} idea_refs ${unknown.join(", ")} are not usable ideas in the bank. Pick from lead_card writing.ideas. Nothing was written.`);
            }
            if (refs.every((n) => had.has(n))) {
              throw new Error(`step ${String(st.id)} uses ${refs.map((n) => `#${n}`).join(", ")}, which this lead has already been sent. Pick an idea they have not had. Nothing was written.`);
            }
            // A trial idea reaches a few leads, then waits for what they did before it goes wider.
            for (const n of refs.filter((r) => known.get(r)?.status === "trial")) {
              const leads = await ideaLeadCount({ orgId: ctx.orgId, productId: String(instance.productId), n, excludeInstanceId: String(instance._id) });
              if (leads >= TRIAL_LEADS) {
                throw new Error(`step ${String(st.id)} uses #${n}, a trial idea already planned for ${leads} leads. It waits for their results before anyone else gets it. Pick another idea. Nothing was written.`);
              }
            }
            if (refs.every((n) => (usage.get(n) ?? 0) >= cap)) {
              throw new Error(`step ${String(st.id)} uses ${refs.map((n) => `#${n}`).join(", ")}, already planned for ${cap} or more other leads in this campaign this week. Pick another idea that fits this lead. Nothing was written.`);
            }
            st.idea_refs = refs;
          }
        }
        // An idea this lead was given and did nothing with is spent for them after one send, not
        // two: a short plan cannot afford to say the same thing twice. A click rescues it.
        const triedOnce = await anglesTriedOn(ctx.orgId, String(instance.productId), String(instance.personId));
        const ignored = new Set(triedOnce.filter((t) => !t.clicked).map((t) => t.angle));
        const again = (planSteps as Array<Record<string, unknown>>).filter((st) => ignored.has(String(st.angle)));
        if (again.length) {
          throw new Error(
            `This lead already had ${again.map((st) => `"${String(st.theme)}"`).join(", ")} and did not act on it. Pick an idea they have not seen. Nothing was written.`,
          );
        }
      }

      // Each step names the email it sends. In a campaign that plans each lead that is the
      // plan itself: "Feature followup" seven times told nobody reading the lead page what
      // the lead would get. So there a step names one real email, never the family, never
      // the welcome, and never one this lead already had.
      const perLeadFamily = (goalDef?.perLeadPlan as { family?: string } | undefined)?.family;
      const templateRows = await db
        .collection(C.templates)
        .find({ orgId: ctx.orgId, productId: String(instance.productId), status: "active" }, { projection: { key: 1, family: 1, covers: 1, channel: 1, providerTemplate: 1 } })
        .toArray();
      const templateByKey = new Map(templateRows.map((t) => [String(t.key), t]));
      const families = new Set(templateRows.map((t) => String(t.family ?? "")).filter(Boolean));
      // A key only counts on the channel its template sends on. Checked by key alone, an email
      // family let every step of a WhatsApp plan through, and each one failed at send.
      const onChannel = new Set(templateRows.flatMap((t) => [String(t.key), String(t.family ?? "")].filter(Boolean).map((k) => `${String(t.channel ?? "email")}:${k}`)));
      const opener = String((goalDef?.firstTouch as { templateKey?: string } | undefined)?.templateKey ?? "");
      const sentKeys = new Set(await rungsSentTo(String(instance.personId)));
      const menu = perLeadFamily ? [...new Set(templateRows.filter((t) => t.family === perLeadFamily).map((t) => String(t.key)))] : [];
      const keyOf = (st: Record<string, unknown>) => String(st.template_key ?? st.templateKey ?? "").trim();
      const templateProblems: string[] = [];
      const inPlan = new Set<string>();
      for (const st of planSteps as Array<Record<string, unknown>>) {
        const key = keyOf(st);
        const step = `step ${String(st.id)}`;
        if (!key) {
          if (perLeadFamily) templateProblems.push(`${step} names no template_key. Pick one of: ${menu.join(", ")}.`);
          continue;
        }
        const row = templateByKey.get(key);
        if (!row && !families.has(key)) {
          templateProblems.push(`${step}: there is no active template "${key}".`);
          continue;
        }
        const stepChannel = String(st.channel ?? "email");
        if (!onChannel.has(`${stepChannel}:${key}`)) {
          const elsewhere = [...onChannel].filter((k) => k.endsWith(`:${key}`)).map((k) => k.split(":")[0]);
          templateProblems.push(`${step} goes on ${stepChannel}, but "${key}" is a ${elsewhere.join("/") || "different"} template.`);
          continue;
        }
        // A template the writer fills is written fresh for every touch, like the frame: it is
        // never "already had", and a plan may use it at every step.
        if (row && takesWrittenWords(row)) {
          inPlan.add(key);
          continue;
        }
        if (rolling && key === frameKey) {
          // The frame is written fresh for every touch, so it is never "already had".
          continue;
        }
        if (perLeadFamily) {
          if (!row) templateProblems.push(`${step} names the family "${key}". Name the email itself: ${menu.join(", ")}.`);
          if (opener && (key === opener || String(row?.family ?? "") === opener)) {
            templateProblems.push(`${step} names the welcome, which went out when they arrived.`);
          }
        }
        if (sentKeys.has(key)) templateProblems.push(`${step}: this lead already had "${key}".`);
        const repeats = ((row?.covers ?? []) as unknown[]).map(String).filter((k) => sentKeys.has(k));
        if (repeats.length) templateProblems.push(`${step}: "${key}" repeats what they already had in ${repeats.join(", ")}.`);
        if (row && !families.has(key) && inPlan.has(key)) templateProblems.push(`${step}: "${key}" is already an earlier step of this plan.`);
        inPlan.add(key);
      }
      const budgetTouches = (goalDef?.budget as { touches?: number } | undefined)?.touches;
      const spentTouches = Number((instance.spent as { touches?: number } | undefined)?.touches ?? 0);
      if (budgetTouches !== undefined && planSteps.length > budgetTouches - spentTouches) {
        templateProblems.push(
          `the plan has ${planSteps.length} steps but only ${Math.max(0, budgetTouches - spentTouches)} touches are left in this campaign's budget.`,
        );
      }
      if (templateProblems.length > 0) {
        throw new Error(`This plan names templates it cannot send:\n- ${templateProblems.join("\n- ")}\nNothing was written.`);
      }

      // Assets are checked at plan time as well as at compose time, because a step can
      // fire before anybody writes copy for it — the rung's fallback goes out carrying
      // whatever the plan named. A plan holding an expired case study is a message nobody
      // reviewed sending an argument that is no longer true.
      const planAssets = planSteps
        .map((st) => ({ id: String(st.asset_id ?? ""), channel: String(st.channel ?? "") }))
        .filter((st) => st.id);
      if (planAssets.length > 0) {
        const context = await assetContextFor(
          ctx.orgId,
          String(instance.productId),
          String(instance.personId),
          goalDef,
        );
        const problems: string[] = [];
        for (const step of planAssets) {
          problems.push(
            ...(await assetRefusals(ctx.orgId, String(instance.productId), context, [step.id], step.channel)),
          );
        }
        // Two steps carrying the same asset is the already-sent rule arriving one plan
        // early: the second send is the one that reads as nobody keeping track, and it is
        // easier to catch here than after the first has gone out.
        const counts = new Map<string, number>();
        for (const step of planAssets) counts.set(step.id, (counts.get(step.id) ?? 0) + 1);
        for (const [id, n] of counts) {
          if (n > 1) problems.push(`${id} is carried by ${n} steps of this plan. One asset, one touch.`);
        }
        if (problems.length > 0) {
          throw new Error(`This plan cannot carry what it names:\n- ${problems.join("\n- ")}`);
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
      const angles = planSteps.map((st) => String(st.angle));
      // A plan of one or two touches cannot hold a third of anything. In a rolling campaign
      // exploration is kept across the group instead, and lead_card says how it stands.
      const block = rolling ? null : await explorationBlock(ctx.orgId, String(instance.productId), segment, angles);
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

      // Step numbers already spent on this lead stay spent: the engine counts a step as
      // written by its number, so a new step 1 on a lead whose old step 1 went out would be
      // skipped for good. On a clash the whole plan moves past the highest number used.
      const priorSteps = await db
        .collection(C.actions)
        .find(
          { goalInstanceId, planStepId: { $exists: true }, status: { $nin: ["queued", "awaiting_approval"] } },
          { projection: { planStepId: 1 } },
        )
        .toArray();
      const taken = priorSteps.map((a) => Number(a.planStepId)).filter((n) => Number.isFinite(n));
      const shift = planSteps.some((st) => taken.includes(Number(st.id))) ? Math.max(...taken) : 0;
      // Stored under the name the engine reads, so the step renders through the email it names.
      const storedSteps = (planSteps as Array<Record<string, unknown>>).map((st) => {
        const key = keyOf(st);
        return { ...st, id: Number(st.id) + shift, ...(key ? { templateKey: key } : {}) };
      });

      const planId = new ObjectId();
      await db.collection(C.plans).insertOne({
        _id: planId,
        orgId: String(instance.orgId),
        // Every other collection is scoped by both. Without productId a plan cannot be
        // found by the product that owns it, only by walking its goal instance.
        productId: String(instance.productId),
        goalInstanceId,
        version,
        steps: storedSteps,
        rationale,
        // Marks a plan written for the rolling planner. Only these run in a rolling campaign;
        // anything older reads as spent there.
        ...(rolling ? { rolling: true } : {}),
        createdBy: "claude",
        createdAt: new Date(),
      });
      await db
        .collection(C.goalInstances)
        .updateOne({ _id: instance._id }, { $set: { currentPlanId: String(planId) } });

      // Messages waiting from the plan being replaced were written for another sequence.
      // They are skipped and their step numbers released, as a playbook stamp does, so the
      // new plan's steps can queue under those numbers.
      const replaced = await db.collection(C.actions).updateMany(
        {
          orgId: String(instance.orgId),
          goalInstanceId,
          status: { $in: ["queued", "awaiting_approval"] },
          planStepId: { $exists: true },
        },
        [
          {
            $set: {
              status: "skipped",
              skipReason: "plan replaced by Claude's plan for this lead",
              replacedPlanStepId: "$planStepId",
              idempotencyKey: { $concat: [{ $ifNull: ["$idempotencyKey", ""] }, ":replaced:", { $toString: "$_id" }] },
            },
          },
          { $unset: "planStepId" },
        ],
      );

      return {
        plan_id: String(planId),
        version,
        steps: storedSteps.length,
        step_ids: storedSteps.map((st) => st.id),
        replaced_waiting: replaced.modifiedCount,
      };
    },
  },

  {
    name: "compose_batch",
    description:
      "Write the actual copy for upcoming touches and queue them. Your part of each body is at most 90 words with no links, and the finished mail stays under 200 words; lead_card's skeleton shows what the template adds. Each becomes a scheduled message; the engine sends it when due, under every guardrail. Never repeat a claim already made to this person. A touch may carry assets from lead_card's assets_available; carrying none is the normal case. Anything not on that list is refused with the reason, and what an asset proves counts as said. A WhatsApp touch goes as an approved template, sent by name: body fills its {{message}} and question its {{question}}, nothing else is sent, and template_key names which template (lead_card's skeleton for the step lists the choices).",
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
              template_key: {
                type: "string",
                description:
                  "WhatsApp (or any channel whose messages are approved provider templates): which template carries this " +
                  "touch, from the choices in lead_card's skeleton. Omit to use the one the plan step names.",
              },
              subject: { type: "string" },
              body: {
                type: "string",
                description:
                  "Markdown, at most 90 words, no links. Write the message only: the greeting, the " +
                  "call-to-action button, the sign-off and the unsubscribe line belong to the template " +
                  "and are added around it. On a WhatsApp template this is its {{message}}: one paragraph " +
                  `of at most ${WRITTEN_MESSAGE_MAX_WORDS} words with no line break, no greeting and no sign-off.`,
              },
              preheader: {
                type: "string",
                description:
                  "Optional. The grey line an inbox shows after the subject: under 90 characters, one detail " +
                  "from their situation, never a repeat of the subject. Omit to keep the template's own.",
              },
              ps: {
                type: "string",
                description:
                  "Optional, only where the template has a PS line: one line of at most 25 words, no link, " +
                  "offering an easy second route that fits this person. Omit to keep the template's own PS.",
              },
              ask: {
                type: "string",
                enum: ["reply", "link"],
                description:
                  "What this message asks for. \"reply\" renders it without the template's button, so the " +
                  "only thing to do is answer; the body must then end on a question a person can answer in " +
                  "one line. Use it for the first two written touches to anyone who has not clicked, and for " +
                  "anyone who has gone quiet. \"link\" keeps the button and is the default.",
              },
              claims_made: { type: "array", items: { type: "string" } },
              format: {
                type: "string",
                enum: ["text", "html", "letter"],
                description:
                  "Required where the step renders through the campaign's frame (a rolling campaign). \"text\" sends a " +
                  "plain note and only asks for a reply: it carries no link. \"letter\" is HTML that looks typed — no logo, " +
                  "box or button, bold phrases and a link on its own words — for a link ask or where bold carries the idea. " +
                  "\"html\" sends the branded design, for a sample, table or screen, or a lead who engages with designed mail.",
              },
              format_why: { type: "string", description: "One sentence: why this format for this person now." },
              opening: {
                type: "string",
                description:
                  "Frame touches, written in parts instead of body: the first line, one sentence under 90 characters, shown bold in HTML. " +
                  "In plain text it is the inbox preview after the subject, so it must not repeat the subject.",
              },
              timeline: {
                type: "array",
                items: { type: "object", properties: { when: { type: "string" }, what: { type: "string" } }, required: ["when", "what"] },
                description:
                  "Layout test, story ideas only: 2 to 4 moments in order, when is a day or time (\"Monday\", \"8 PM\"), what is " +
                  "one short sentence. Shown under the opening. Follow the arm in lead_card writing.layout_tests.",
              },
              reveal: {
                type: "string",
                description:
                  "Hot emails: the no-way part, 1 to 3 short lines (blank line between) saying what TeamGrid already knows or " +
                  "does about the moment above, plainly and truly. Shown between two thin lines with TeamGrid's name in the brand shade.",
              },
              receipt: {
                type: "object",
                properties: { title: { type: "string" }, lines: { type: "array", items: { type: "string" } } },
                description:
                  "Hot emails: what day 1 would show, written like the product's own view, as a sample. title says it is a " +
                  "sample (default \"A sample hour in TeamGrid:\"); 2 to 5 lines under 48 characters, for example " +
                  "\"14:00–15:00 · score 40%\", \"meetings in blue · idle in grey\", \"09:04 standup · 18m\".",
              },
              link_page: {
                type: "string",
                description:
                  "Optional, link asks only. A page from lead_card writing.context (pages_for_this_lead, pages or " +
                  "other_solution_pages) that fits this lead better than the start link: their segment's solution page, " +
                  "the comparison with a tool they use, pricing when cost is the question. The button, and every link in " +
                  "the mail, goes there instead. Omit to send them to the start link.",
              },
              cta_text: {
                type: "string",
                enum: [...CTA_TEXTS],
                description: "Optional words on the button. The reveal (\"See the first day\") rather than the signup, except on the hidden bill email.",
              },
              reply_options: {
                type: "array",
                items: { type: "string" },
                description:
                  "Layout test, reply asks only: 2 to 4 short answers to the question, shown as \"Reply with one number:\" and " +
                  "\"1 = …\" lines. Follow the arm in lead_card writing.layout_tests.",
              },
              scene: { type: "string", description: "One or two short paragraphs (blank line between) that make the idea their scene. At most two **bold** phrases." },
              cost_intro: { type: "string", description: "Optional heading over the cost lines. Defaults to \"For example:\"." },
              cost_lines: {
                type: "array",
                items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label"] },
                description:
                  "Up to 3 cost lines: label is the situation with its numbers (under 40 characters), value is what it costs " +
                  "(under 50). A tinted box in HTML; in plain text the label, then \"→ value\" on the line under it.",
              },
              shows_intro: { type: "string", description: "Optional line over the list. Defaults to \"What TeamGrid would show you:\"." },
              shows: { type: "array", items: { type: "string" }, description: "Up to 3 lines under 50 characters on what they would see. A check list in HTML, dashes in plain text." },
              limit: { type: "string", description: "Optional one line on what is not recorded, where the fit is partial." },
              question: {
                type: "string",
                description:
                  "The closing question, one line they can answer; shown bold in HTML. On a WhatsApp template with a " +
                  `{{question}}, it fills that: one line of at most ${WRITTEN_QUESTION_MAX_WORDS} words ending in a question mark.`,
              },
              theme: { type: "string", description: "The idea in words. Defaults to the plan step's theme." },
              hook: { type: "string", description: "How the idea lands: story, rupee_math, question, comparison, proof, or your own word." },
              asset_ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional. Assets this message carries, from lead_card's assets_available. Omit the " +
                  "field to keep whatever the plan named for this step; pass an empty array to deliberately " +
                  "send words alone where the plan had named something. Most messages carry nothing. " +
                  "Where one is carried, write the copy to lead into it — what it proves is already counted " +
                  "as said, so do not spend the message arguing it again.",
              },
              rationale: { type: "string" },
            },
            required: ["step_id", "after_days", "channel", "angle", "rationale"],
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
      // The plan_goal guard against a stepless plan was once pasted here too, where it
      // read a `steps` argument this tool never receives — so every compose_batch failed
      // with "a plan needs at least one step" and nothing a session wrote was ever queued.
      if (touches.length === 0) throw new Error("compose_batch needs at least one touch. Nothing was written.");
      for (const t of touches) {
        if (!String(t.rationale ?? "").trim()) throw new Error(`step ${String(t.step_id)} needs a rationale in words. Nothing was written.`);
      }

      // Touches that go as an approved provider template (WhatsApp): the template is sent by
      // name and only its variables change, so the writer fills {{message}} and, where it has
      // one, {{question}}. Resolved before anything else reads the touch, because here
      // `question` is that variable and not the closing line of a mail written in parts.
      // Nothing did this before: the words went into the slot, the variables stayed empty,
      // and every planned WhatsApp step failed or would have been refused by WATI.
      const writtenTpl = await writtenTemplatesFor(orgId, productId);
      const planForTouches = instance.currentPlanId && ObjectId.isValid(String(instance.currentPlanId))
        ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) }, { projection: { steps: 1 } })
        : null;
      const planStepFor = new Map(((planForTouches?.steps ?? []) as Array<Record<string, unknown>>).map((st) => [Number(st.id ?? st.step_id), st]));
      const providerTouch = new Map<Record<string, unknown>, Record<string, unknown>>();
      for (const t of touches) {
        const step = String(t.step_id);
        const channel = String(t.channel ?? "");
        const choices = [...writtenTpl.byKey.values()].filter((row) => String(row.channel) === channel).map((row) => String(row.key));
        const named = str(t.template_key)?.trim();
        const stepKey = String(planStepFor.get(Number(t.step_id))?.templateKey ?? planStepFor.get(Number(t.step_id))?.template_key ?? "");
        if (named) {
          const row = writtenTpl.byKey.get(named);
          if (!row || String(row.channel) !== channel) {
            throw new Error(
              `step ${step} names template_key "${named}", which is not an active ${channel} template that takes written words. ` +
                (choices.length ? `Use one of: ${choices.join(", ")}.` : `This product has none on ${channel}.`) + " Nothing was written.",
            );
          }
          providerTouch.set(t, row);
          continue;
        }
        const fromStep = writtenTpl.byKey.get(stepKey);
        if (fromStep && String(fromStep.channel) === channel) {
          providerTouch.set(t, fromStep);
          continue;
        }
        if (writtenTpl.channels.has(channel) && !writtenTpl.activeKeys.has(stepKey)) {
          throw new Error(
            `step ${step} goes on ${channel}, where every message is an approved template with your words in it. ` +
              `Name one as template_key: ${choices.join(", ")}. Nothing was written.`,
          );
        }
      }
      for (const [t, row] of providerTouch) {
        const step = String(t.step_id);
        const key = String(row.key);
        const takes = writtenParamsOf(row);
        const message = String(t.body ?? "").trim();
        const question = String(t.question ?? "").trim();
        // Meta refuses a variable holding a line break, a tab or more than four spaces in a
        // row, and the provider may still answer OK. Said here, before anyone reviews it.
        const unsendable = (x: string) => /[\n\t]/.test(x) || / {5,}/.test(x);
        const wordsIn = (x: string) => x.split(/\s+/).filter(Boolean).length;
        const stray = ["subject", "preheader", "ps", "opening", "scene", "cost_lines", "shows", "receipt", "reveal", "timeline", "reply_options", "format", "cta_text", "limit"].filter(
          (k) => t[k] !== undefined && String(t[k] ?? "").trim() !== "",
        );
        if (stray.length) {
          throw new Error(`step ${step} goes as the approved template "${key}", which takes body and question only; leave out ${stray.join(", ")}. Nothing was written.`);
        }
        if (!message) throw new Error(`step ${step} has no body. It is the "${key}" template's {{message}}. Nothing was written.`);
        if (unsendable(message)) {
          throw new Error(`step ${step} body has a line break, a tab or a run of spaces. It goes into one WhatsApp template variable, which cannot hold them: write one paragraph. Nothing was written.`);
        }
        if (wordsIn(message) > WRITTEN_MESSAGE_MAX_WORDS) {
          throw new Error(`step ${step} body is ${wordsIn(message)} words. The "${key}" template's {{message}} takes at most ${WRITTEN_MESSAGE_MAX_WORDS}. Nothing was written.`);
        }
        if (/^(hi|hello|hey|dear|greetings|good (morning|afternoon|evening))\b/i.test(message)) {
          throw new Error(`step ${step} body opens with a greeting. The "${key}" template already says hello by name; start with what you have to say. Nothing was written.`);
        }
        if (/(regards|thanks|thank you|cheers|sincerely|the teamgrid team)[\s,.!]*$/i.test(message)) {
          throw new Error(`step ${step} body ends with a sign-off. The "${key}" template signs off itself. Nothing was written.`);
        }
        if (takes.includes("question")) {
          if (!question) throw new Error(`step ${step}: the "${key}" template has a {{question}}; write question, one line ending in a question mark. Nothing was written.`);
          if (unsendable(question)) throw new Error(`step ${step} question has a line break, a tab or a run of spaces, which a WhatsApp variable cannot hold. Nothing was written.`);
          if (!/\?$/.test(question)) throw new Error(`step ${step} question does not end with a question mark. Nothing was written.`);
          if (wordsIn(question) > WRITTEN_QUESTION_MAX_WORDS) {
            throw new Error(`step ${step} question is ${wordsIn(question)} words; keep it to ${WRITTEN_QUESTION_MAX_WORDS}. Nothing was written.`);
          }
        } else if (question) {
          const withQuestion = [...writtenTpl.byKey.values()].filter((r) => String(r.channel) === String(row.channel) && writtenParamsOf(r).includes("question")).map((r) => String(r.key));
          throw new Error(
            `step ${step}: the "${key}" template has no {{question}}. Leave question out${withQuestion.length ? `, or name ${withQuestion.join(" or ")} as template_key` : ""}. Nothing was written.`,
          );
        }
      }

      // A touch written in parts: opening, scene, cost lines, what they would see, a limit
      // and the question. The frame lays each part out for the format; everything below
      // checks the assembled words, so a part cannot slip past a rule the body obeys.
      const structuredParts = new Map<Record<string, unknown>, {
        opening: string; scene: string; question: string; limit: string;
        cost?: { title: string; rows: Array<{ label: string; value: string }> };
        shows?: { title: string; items: string[] };
        timeline?: Array<{ when: string; what: string }>;
        options?: string[];
        receipt?: { title: string; items: string[] };
        reveal?: string;
        ctaText?: string;
        layout: string;
      }>();
      const CAPS_OK = new Set(["CRM", "HRMS", "MIS", "KPI", "KPIS", "GST", "TDS", "ITR", "HVAC", "OEM", "CTC", "SLA", "ERP", "SAAS", "B2B", "D2C", "HR", "IT", "AI", "CEO", "COO", "CFO", "CA", "USA", "UAE", "NOC", "RERA", "AMC", "MEP", "ICU", "OPD", "BPO", "KPO", "FMCG", "TAT", "PAN", "GSTIN", "EMI", "CAD", "BOQ", "RFQ", "PO", "QA", "QC", "UPI", "NBFC"]);
      // Which arm of each layout test this lead sits in, for good (docs/learnings.md PT8).
      const armFor = (test: LayoutTest) => layoutArm(String(instance.personId), test);
      for (const t of touches) {
        if (providerTouch.has(t)) continue;
        const step = String(t.step_id);
        const structured = ["opening", "scene", "question", "cost_lines", "shows", "receipt", "reveal"].some((k) => t[k] !== undefined);
        if (!structured) {
          if (!String(t.body ?? "").trim()) throw new Error(`step ${step} has no body. Write body, or the parts: opening, scene, question. Nothing was written.`);
          continue;
        }
        const opening = String(t.opening ?? "").trim();
        const scene = String(t.scene ?? "").trim();
        const question = String(t.question ?? "").trim();
        const limitLine = String(t.limit ?? "").trim();
        if (!opening || !scene || !question) {
          throw new Error(`step ${step} is written in parts and needs opening, scene and question. Nothing was written.`);
        }
        if (/\*\*/.test(opening) || /\*\*/.test(question)) {
          throw new Error(`step ${step}: leave the ** off opening and question; the frame already sets them bold. Nothing was written.`);
        }
        // In plain text there is no hidden preview line: after the short greeting, the opening
        // is what the inbox shows beside the subject.
        if (opening.length > OPENING_MAX_CHARS) {
          throw new Error(`step ${step} opening is ${opening.length} characters. It is the inbox preview in plain text; keep it under ${OPENING_MAX_CHARS}. Nothing was written.`);
        }
        const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9₹]+/g, " ").trim();
        const subjectSquashed = squash(String(t.subject ?? ""));
        if (subjectSquashed && (squash(opening).includes(subjectSquashed) || subjectSquashed.includes(squash(opening)))) {
          throw new Error(`step ${step} opening repeats the subject. In plain text it is the preview beside the subject, so it has to add something. Nothing was written.`);
        }
        const boldCount = ((scene + limitLine).match(/\*\*[^*]+\*\*/g) ?? []).length;
        if (boldCount > 2) {
          throw new Error(`step ${step} bolds ${boldCount} phrases in the scene. At most two, or nothing stands out. Nothing was written.`);
        }
        const rawRows = Array.isArray(t.cost_lines) ? (t.cost_lines as Array<Record<string, unknown>>) : [];
        const rows = rawRows.map((r) => ({ label: String(r?.label ?? "").trim(), value: String(r?.value ?? "").trim() })).filter((r) => r.label);
        if (rows.length > 3) throw new Error(`step ${step} has ${rows.length} cost lines; keep it to 3 at most. Nothing was written.`);
        const items = (Array.isArray(t.shows) ? (t.shows as unknown[]) : []).map((x) => String(x ?? "").trim()).filter(Boolean);
        if (items.length > 3) throw new Error(`step ${step} lists ${items.length} things they would see; keep it to 3 at most. Nothing was written.`);
        // Short enough for one phone line each. A situation line of 40 characters or more with
        // no full stop is one Outlook joins to the arrow line under it.
        for (const r of rows) {
          if (r.label.length > COST_LABEL_MAX_CHARS) {
            throw new Error(`step ${step} cost line "${r.label}" is ${r.label.length} characters; keep the situation under ${COST_LABEL_MAX_CHARS + 1} and put the rest in its value. Nothing was written.`);
          }
          if (r.value.length > SCAN_LINE_MAX_CHARS) {
            throw new Error(`step ${step} cost value "${r.value}" is ${r.value.length} characters; keep it under ${SCAN_LINE_MAX_CHARS}. Nothing was written.`);
          }
        }
        for (const item of items) {
          if (item.length > SCAN_LINE_MAX_CHARS) {
            throw new Error(`step ${step} list line "${item}" is ${item.length} characters; keep each under ${SCAN_LINE_MAX_CHARS}. Nothing was written.`);
          }
        }

        // The two layouts on test. A lead in the hold-out arm never gets one, a lead in the
        // use arm always does where it applies, so replies compare groups of leads.
        const ask = String(t.ask ?? "link");
        const hook = String(t.hook ?? "").trim().toLowerCase();
        const timeline = (Array.isArray(t.timeline) ? (t.timeline as Array<Record<string, unknown>>) : [])
          .map((r) => ({ when: String(r?.when ?? "").trim().replace(/:$/, ""), what: String(r?.what ?? "").trim() }))
          .filter((r) => r.when && r.what)
          // One style for every line: lower case after the colon ("Monday: the drawing waits."),
          // unless the first word is a name-like one such as TeamGrid or WhatsApp.
          .map((r) => ({ ...r, what: /^[A-Z][a-z]*\b/.test(r.what) && !/^[A-Z][a-z]+[A-Z]/.test(r.what) ? r.what[0]!.toLowerCase() + r.what.slice(1) : r.what }))
          .map((r) => ({ ...r, what: /[.!?]$/.test(r.what) ? r.what : `${r.what}.` }));
        const options = (Array.isArray(t.reply_options) ? (t.reply_options as unknown[]) : []).map((x) => String(x ?? "").trim()).filter(Boolean);
        if (timeline.length) {
          if (armFor("timeline") === "hold_out") {
            throw new Error(`step ${step} writes a timeline, but this lead is in the hold-out group of the timeline test (lead_card writing.layout_tests). Tell it in the scene instead. Nothing was written.`);
          }
          if (hook !== "story") throw new Error(`step ${step}: a timeline is tested on story ideas only; set hook "story" or leave it out. Nothing was written.`);
          if (timeline.length < 2 || timeline.length > 4) throw new Error(`step ${step} timeline has ${timeline.length} moments; use 2 to 4. Nothing was written.`);
          for (const r of timeline) {
            if (r.when.length > 20 || `${r.when}: ${r.what}`.length > 70) {
              throw new Error(`step ${step} timeline line "${r.when}: ${r.what}" is too long; a short day or time and one short sentence. Nothing was written.`);
            }
          }
        } else if (armFor("timeline") === "use" && hook === "story") {
          throw new Error(`step ${step} tells a story, and this lead is in the timeline test group (lead_card writing.layout_tests): add timeline, 2 to 4 moments in order. Nothing was written.`);
        }
        if (options.length) {
          if (armFor("reply_options") === "hold_out") {
            throw new Error(`step ${step} gives reply options, but this lead is in the hold-out group of the reply-options test (lead_card writing.layout_tests). Leave them out. Nothing was written.`);
          }
          if (ask !== "reply") throw new Error(`step ${step}: reply options go with ask "reply" only. Nothing was written.`);
          if (options.length < 2 || options.length > 4) throw new Error(`step ${step} has ${options.length} reply options; use 2 to 4. Nothing was written.`);
          for (const o of options) {
            if (o.length > 36) throw new Error(`step ${step} reply option "${o}" is ${o.length} characters; keep each under 37. Nothing was written.`);
          }
        } else if (armFor("reply_options") === "use" && ask === "reply") {
          throw new Error(`step ${step} asks for a reply, and this lead is in the reply-options test group (lead_card writing.layout_tests): add reply_options, 2 to 4 short answers to the question. Nothing was written.`);
        }
        if (!/\?$/.test(question) && ask === "reply") {
          throw new Error(`step ${step} asks for a reply but the question does not end with a question mark. Nothing was written.`);
        }

        // The day-1 receipt: a sample of what the product shows, never a feature list.
        const rawReceipt = (t.receipt ?? null) as { title?: unknown; lines?: unknown } | null;
        const receiptLines = (Array.isArray(rawReceipt?.lines) ? (rawReceipt!.lines as unknown[]) : []).map((x) => String(x ?? "").trim()).filter(Boolean);
        const receiptTitle = String(rawReceipt?.title ?? "").trim() || "A sample hour in TeamGrid:";
        if (receiptLines.length) {
          if (receiptLines.length < 2 || receiptLines.length > RECEIPT_MAX_LINES) {
            throw new Error(`step ${step} receipt has ${receiptLines.length} lines; use 2 to ${RECEIPT_MAX_LINES}. Nothing was written.`);
          }
          for (const line of receiptLines) {
            if (line.length > RECEIPT_LINE_MAX_CHARS) throw new Error(`step ${step} receipt line "${line}" is ${line.length} characters; keep each under ${RECEIPT_LINE_MAX_CHARS + 1}. Nothing was written.`);
          }
          if (!/sample|example/i.test(receiptTitle)) {
            throw new Error(`step ${step} receipt title "${receiptTitle}" must say it is a sample (for example "A sample hour in TeamGrid:"): these are not the reader's real numbers. Nothing was written.`);
          }
        }
        const revealText = String(t.reveal ?? "").trim();
        if (/\*\*/.test(revealText)) {
          throw new Error(`step ${step}: leave ** off reveal; the frame sets TeamGrid's name apart. Nothing was written.`);
        }
        const ctaText = String(t.cta_text ?? "").trim();
        if (ctaText && !(CTA_TEXTS as readonly string[]).includes(ctaText)) {
          throw new Error(`step ${step} cta_text "${ctaText}" is not one of: ${CTA_TEXTS.join(", ")}. Nothing was written.`);
        }
        if (ctaText && ask !== "link") throw new Error(`step ${step}: cta_text goes with ask "link" only. Nothing was written.`);
        const costTitle = String(t.cost_intro ?? "").trim() || "For example:";
        const showsTitle = String(t.shows_intro ?? "").trim() || "What TeamGrid would show you:";
        // Plain language: one idea per sentence, short enough to read once.
        const tooLong = longSentences([opening, scene, revealText, limitLine, question, costTitle, showsTitle, receiptTitle, ...timeline.map((r) => r.what)].join("\n"));
        if (tooLong.length) {
          throw new Error(`step ${step} has a sentence over ${SENTENCE_MAX_WORDS} words: "${tooLong[0]}". Split it into short sentences, one idea each. Nothing was written.`);
        }
        // The assembled words every other rule reads: word count, links, the form, names, numbers.
        t.body = [
          opening,
          timeline.map((r) => `${r.when}: ${r.what}`).join("\n"),
          scene,
          rows.length ? [costTitle, ...rows.map((r) => `${r.label} ${r.value}`)].join("\n") : "",
          revealText,
          items.length ? [showsTitle, ...items].join("\n") : "",
          receiptLines.length ? [receiptTitle, ...receiptLines].join("\n") : "",
          limitLine,
          question,
          options.length ? ["Reply with one number:", ...options.map((o, i) => `${i + 1} = ${o}`)].join("\n") : "",
        ].filter(Boolean).join("\n\n");
        const base = rows.length && items.length ? "cost_and_list" : rows.length ? "cost_box" : items.length ? "checklist" : "story";
        structuredParts.set(t, {
          opening,
          scene,
          question,
          limit: limitLine,
          ...(rows.length ? { cost: { title: costTitle, rows } } : {}),
          ...(items.length ? { shows: { title: showsTitle, items } } : {}),
          ...(timeline.length ? { timeline } : {}),
          ...(options.length ? { options } : {}),
          ...(receiptLines.length ? { receipt: { title: receiptTitle, items: receiptLines } } : {}),
          ...(revealText ? { reveal: revealText } : {}),
          ...(ctaText ? { ctaText } : {}),
          layout: `${base}${receiptLines.length ? "+receipt" : ""}${timeline.length ? "+timeline" : ""}${options.length ? "+options" : ""}`,
        });
      }
      for (const t of touches) {
        const text = [t.subject, t.preheader, t.body, t.ps].map((v) => String(v ?? "")).join("\n");
        if (/\p{Extended_Pictographic}/u.test(text)) {
          const prone = emojiProneSymbols(text);
          throw new Error(
            prone.length
              ? `step ${String(t.step_id)} uses ${prone.join(" ")}, which phones show as colour emoji. Use → – × = ₹ • ✓ instead. Nothing was written.`
              : `step ${String(t.step_id)} carries an emoji. Keep the register professional. Nothing was written.`,
          );
        }
        const prone = emojiProneSymbols(text);
        if (prone.length) {
          throw new Error(`step ${String(t.step_id)} uses ${prone.join(" ")}, which phones show as colour emoji or spam filters distrust. Use → – × = ₹ • ✓ instead. Nothing was written.`);
        }
        const shouting = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !CAPS_OK.has(w));
        if (shouting.length) {
          throw new Error(`step ${String(t.step_id)} writes "${shouting[0]}" in capitals. Use normal case; emphasis comes from layout and at most two bold phrases. Nothing was written.`);
        }
        // Digits catch a skimming eye where words do not (Nielsen Norman Group's eye-tracking).
        if (structuredParts.has(t)) {
          const spelled = spelledQuantities(text);
          if (spelled.length) {
            throw new Error(`step ${String(t.step_id)} spells out ${spelled.map((x) => `"${x}"`).join(", ")}. Write quantities as digits ("5 days", "9 hours", "3 of 9 hours"), which a skimming eye catches. Nothing was written.`);
          }
        }
      }

      // Where a step renders through the campaign's frame, the session writes the whole
      // message: more room, a format decision with its reason, and the truth rules that a
      // fixed template used to carry by being fixed.
      const campaignDef = await db.collection(C.goals).findOne({ orgId, productId, key: String(instance.goalKey) });
      const currentPlan = instance.currentPlanId && ObjectId.isValid(String(instance.currentPlanId))
        ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) })
        : null;
      const frameKey = frameKeyOf(campaignDef);
      const stepRows = new Map(((currentPlan?.steps ?? []) as Array<Record<string, unknown>>).map((st) => [Number(st.id ?? st.step_id), st]));
      const isFrameTouch = (t: Record<string, unknown>) =>
        isRolling(campaignDef) && String(stepRows.get(Number(t.step_id))?.templateKey ?? "") === frameKey;
      const writer = await db.collection(C.products).findOne({ _id: new ObjectId(productId) }, { projection: { config: 1 } });
      const subjectAvoid = (((writer?.config as { writing?: { subjectAvoid?: string[] } } | undefined)?.writing?.subjectAvoid) ?? []).map(String).filter(Boolean);
      const plainWriting = ((writer?.config as { writing?: { oneLine?: string; wordsAvoid?: Array<{ word: string; use: string }> } } | undefined)?.writing ?? {});
      const wordsAvoid = (plainWriting.wordsAvoid ?? []).filter((w) => w && w.word);
      const oneLine = String(plainWriting.oneLine ?? "").trim();
      const samples = (((writer?.config as { writing?: { facts?: { samples?: unknown[] } } } | undefined)?.writing?.facts?.samples) ?? []).map(String).filter(Boolean);
      const lead = await db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) });
      const companyWords = companyTokens(lead);
      const warnings: string[] = [];
      for (const t of touches) {
        const step = String(t.step_id);
        const subjectText = String(t.subject ?? "");
        for (const word of subjectAvoid) {
          if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(subjectText)) {
            throw new Error(`step ${step} subject uses "${word}", which this product keeps out of subjects. Nothing was written.`);
          }
        }
        if (!isFrameTouch(t)) continue;
        const format = String(t.format ?? "");
        if (format !== "text" && format !== "html" && format !== "letter") {
          throw new Error(`step ${step} renders through the frame and needs format "text", "letter" or "html", with format_why. Nothing was written.`);
        }
        // A link in plain text prints as a long tracked address, and links in early mail cost
        // inbox placement. Plain text asks for a reply; a click goes out as a letter or HTML.
        if (format === "text" && String(t.ask ?? "link") !== "reply") {
          throw new Error(`step ${step} is plain text with a link ask. Plain text asks for a reply and carries no link; use format "letter" for a link ask. Nothing was written.`);
        }
        if (!String(t.format_why ?? "").trim()) {
          throw new Error(`step ${step} needs format_why: one sentence on why ${format} suits this person now. Nothing was written.`);
        }
        // What the campaign's lead type asks for. People who asked for the product are pushed
        // to the next step with the link; a reply-only touch is kept for the hooks the type
        // allows it on, such as a hot campaign's closing email.
        const leadType = leadTypeOf(campaignDef);
        if (leadType) {
          const profile = LEAD_TYPE_PROFILES[leadType];
          const askNow = String(t.ask ?? "link");
          const hookNow = String(t.hook ?? stepRows.get(Number(t.step_id))?.hook ?? "").trim().toLowerCase();
          // The reveal: every hot email shows the day-1 receipt and says, before its button, that
          // nobody is watched. Without the first the reader nods and deletes; without the second
          // it reads as spyware. The closing note is exempt.
          const sp = structuredParts.get(t);
          if (profile.reveal && sp && !profile.replyHooks.includes(hookNow)) {
            if (!sp.reveal && !sp.receipt) {
              throw new Error(`step ${step} is a ${profile.label.toLowerCase()} email with no reveal. Add reveal: 1 to 3 short lines on what TeamGrid already knows or does about this moment. Nothing was written.`);
            }
            const screen = screenWords([t.subject, t.preheader, t.body, t.ps].map((v) => String(v ?? "")).join("\n"));
            if (screen.length) {
              throw new Error(`step ${step} says "${screen[0]}". Say what TeamGrid shows, never what its screen looks like: no colours or screen words. Nothing was written.`);
            }
            if (!/screenshot/i.test(sp.limit) || !/\btype|typed|typing\b/i.test(sp.limit)) {
              throw new Error(`step ${step} needs the safety line in limit, before the button: no screenshots, and nothing people type is recorded. Nothing was written.`);
            }
          }
          if (profile.ask === "link" && askNow === "reply" && !profile.replyHooks.includes(hookNow)) {
            throw new Error(
              `step ${step} asks only for a reply, but this is a ${profile.label.toLowerCase()} campaign: these people ${profile.who}. ` +
                `Ask "link" (format "letter" or "html") so the touch leads to the trial${profile.replyHooks.length ? `; a reply ask is kept for hook ${profile.replyHooks.map((h) => `"${h}"`).join(" or ")}` : ""}. Nothing was written.`,
            );
          }
        }
        if (!String(t.subject ?? "").trim()) {
          throw new Error(`step ${step} renders through the frame, which has no subject of its own. Write one. Nothing was written.`);
        }
        const everything = [t.subject, t.preheader, t.body, t.ps].map((v) => String(v ?? "")).join("\n").toLowerCase();
        const pointsAtForm = /\byou (named|mentioned|told us|said|shared|filled|submitted|selected|wrote|listed|indicated|flagged|picked|chose)\b|\byour (form|answer|response|submission)\b|\bon the form\b/i.exec(everything);
        if (pointsAtForm) {
          throw new Error(`step ${step} says "${pointsAtForm[0]}", which tells them we are reading back what they submitted. Write about their situation directly instead. Nothing was written.`);
        }
        if (structuredParts.has(t)) {
          const hard = avoidedWord([t.subject, t.body, t.ps].map((v) => String(v ?? "")).join("\n"), wordsAvoid);
          if (hard) {
            throw new Error(`step ${step} uses "${hard.word}", a word readers stumble on. Say "${hard.use}" instead. Nothing was written.`);
          }
          const card = structuredParts.get(t)?.receipt;
          const invented = card && samples.length ? unsampledFigures(card.items, samples) : [];
          if (invented.length) {
            throw new Error(`step ${step} sample card has ${invented.map((f) => `"${f}"`).join(", ")}, which the product's published samples do not show. Use only the figures in writing.facts.samples; the nouns may fit their business. Nothing was written.`);
          }
          // A reader who has never heard of the product must not have to guess what it is.
          // A hot email's reveal already says what the product does, in the reader's moment.
          const revealed = Boolean(structuredParts.get(t)?.reveal) && Boolean(leadTypeOf(campaignDef) && LEAD_TYPE_PROFILES[leadTypeOf(campaignDef)!].reveal);
          if (oneLine && !revealed) {
            const key = [...new Set(oneLine.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
            const have = key.filter((w) => everything.includes(w)).length;
            if (key.length && have / key.length < 0.6) {
              warnings.push(`step ${step} never says what the product is in plain words. Add it once, usually as the line above what they would see, for example: "${oneLine}"`);
            }
          }
        }
        const unproven = unprovenClaims([t.subject, t.preheader, t.body, t.ps].map((v) => String(v ?? "")).join("\n"));
        if (unproven.length) {
          throw new Error(`step ${step} says "${unproven[0]}". Never quote customers or claim a result nobody measured, and never say anyone was caught or wasting time: the hour had no owner. Nothing was written.`);
        }
        const named = companyWords.find((token) => everything.includes(token));
        if (named) {
          throw new Error(`step ${step} names their company ("${named}"). Describe what they do instead of printing the name. Nothing was written.`);
        }
        const numbers = unlabelledNumbers(String(t.body ?? ""));
        if (numbers.length && ((t.asset_ids ?? []) as unknown[]).length === 0) {
          warnings.push(`step ${step}: ${numbers.join(", ")} reads as a fact. If it is an example, say so in the sentence; if it is a fact, it must come from product_config.writing.facts.`);
        }
      }

      // The same truth rules for a template's variables: they are short, but they are the
      // only words in the message that were written for this person.
      for (const [t] of providerTouch) {
        const step = String(t.step_id);
        const said = [t.body, t.question].map((v) => String(v ?? "")).join("\n");
        const pointsAtForm = /\byou (named|mentioned|told us|said|shared|filled|submitted|selected|wrote|listed|indicated|flagged|picked|chose)\b|\byour (form|answer|response|submission)\b|\bon the form\b/i.exec(said);
        if (pointsAtForm) {
          throw new Error(`step ${step} says "${pointsAtForm[0]}", which tells them we are reading back what they submitted. Write about their situation directly instead. Nothing was written.`);
        }
        const unproven = unprovenClaims(said);
        if (unproven.length) {
          throw new Error(`step ${step} says "${unproven[0]}". Never quote customers or claim a result nobody measured. Nothing was written.`);
        }
        const named = companyWords.find((token) => said.toLowerCase().includes(token));
        if (named) throw new Error(`step ${step} names their company ("${named}"). Describe what they do instead of printing the name. Nothing was written.`);
      }

      // Limits a reader feels, enforced here so a human in Review never has to trim a mail.
      // One problem and one thing they would see fits in 90 words; a link in the body is a
      // second ask beside the template's one button; the preheader and PS are short or absent.
      const LINK = /https?:\/\/|www\.[a-z0-9]/i;
      const psLine = (text: string) => (/^p\.?\s?s\b/i.test(text) ? text : `P.S. ${text}`);
      // The frame's named places for a touch written in parts. Timeline moments and reply
      // options are lines of one block each, their labels bold in HTML and plain in text.
      const partSlots = (sp: NonNullable<ReturnType<typeof structuredParts.get>>, ps: string): Record<string, string> => ({
        opening: `**${sp.opening}**`,
        question: `**${sp.question}**`,
        ...(sp.limit ? { limit: sp.limit } : {}),
        ...(sp.reveal ? { reveal: sp.reveal } : {}),
        ...(sp.timeline ? { timeline: sp.timeline.map((r) => `**${r.when}:** ${r.what}`).join("\n") } : {}),
        ...(sp.options ? { options: ["Reply with one number:", ...sp.options.map((o, i) => `**${i + 1}** = ${o}`)].join("\n") } : {}),
        ...(sp.ctaText ? { cta_text: sp.ctaText } : {}),
        ...(ps ? { ps } : {}),
      });
      for (const t of touches) {
        const step = String(t.step_id);
        const body = String(t.body ?? "");
        const words = body.split(/\s+/).filter(Boolean).length;
        const typeNow = leadTypeOf(campaignDef);
        const limit = isFrameTouch(t) ? (typeNow ? LEAD_TYPE_PROFILES[typeNow].maxWords : FRAME_BODY_MAX_WORDS) : 90;
        if (words > limit) {
          throw new Error(`step ${step} is ${words} words. Your part is at most ${limit}: one idea in their world and what the product shows about it. Nothing was written.`);
        }
        if (LINK.test(body)) {
          throw new Error(`step ${step} carries a link. The template already has the one button this mail asks for; a second link is a second ask. Nothing was written.`);
        }
        // A template's own buttons are its ask; the question, where it has one, is separate.
        if (providerTouch.has(t)) continue;
        const ask = String(t.ask ?? "link");
        if (ask !== "link" && ask !== "reply") {
          throw new Error(`step ${step} ask is "${ask}"; it is "reply" or "link". Nothing was written.`);
        }
        if (ask === "reply" && !structuredParts.has(t) && !/\?\s*$/.test(body.trim())) {
          throw new Error(`step ${step} asks for a reply but does not end on a question. A reply ask is a question they can answer in one line. Nothing was written.`);
        }
        const pre = String(t.preheader ?? "").trim();
        if (pre) {
          const subject = String(t.subject ?? "").trim().toLowerCase();
          if (pre.length > 90) throw new Error(`step ${step} preheader is ${pre.length} characters; keep it under 90. Nothing was written.`);
          if (LINK.test(pre)) throw new Error(`step ${step} preheader carries a link. Nothing was written.`);
          if (subject && (pre.toLowerCase().includes(subject) || subject.includes(pre.toLowerCase()))) {
            throw new Error(`step ${step} preheader repeats the subject; it should add a detail instead. Nothing was written.`);
          }
        }
        const ps = String(t.ps ?? "").trim();
        if (ps) {
          const psWords = ps.split(/\s+/).filter(Boolean).length;
          if (psWords > 25) throw new Error(`step ${step} ps is ${psWords} words; keep it to one line under 25. Nothing was written.`);
          if (LINK.test(ps)) throw new Error(`step ${step} ps carries a link. Nothing was written.`);
        }
      }
      const queued: string[] = [];

      // Refused here rather than cleaned up later. Copy that signs off with its own link
      // lands under a template that ends with a button to the same place, and the reader
      // gets the destination twice — once as a raw tracking URL mid-sentence. The writer
      // cannot see the skeleton it is writing into, so the contract has to be stated on
      // the way in; a message already in the queue is one somebody has to notice.
      for (const t of touches) {
        const offending = signOffLink(String(t.body ?? ""));
        if (offending) {
          throw new Error(
            `step ${String(t.step_id)} ends with "${offending}". The template adds its own button to that ` +
              `same link, so this sends the reader two of them. Write the message only — no start link, ` +
              `no unsubscribe line — and let the skeleton supply the call to action.`,
          );
        }
      }

      // A product that writes as "we" does not get a message from "I". The voice is the
      // product's own words on the card; a session that read them and still wrote in the
      // first person singular is told so here rather than after somebody approved it.
      const productDoc = await db.collection(C.products).findOne({ _id: new ObjectId(productId) }, { projection: { config: 1 } });
      // A page for the button has to be one the product's context lists: a URL a session
      // made up, or one taken off the site, is a broken link in a mail somebody approved.
      {
        const pageUrls = new Set((contextOf(productDoc)?.pages ?? []).map((p) => p.url));
        for (const t of touches) {
          const page = String(t.link_page ?? "").trim();
          if (!page) continue;
          if (String(t.ask ?? "link") === "reply") {
            throw new Error(`step ${String(t.step_id)}: link_page goes with ask "link" only; a reply ask has no button. Nothing was written.`);
          }
          if (providerTouch.has(t)) {
            throw new Error(`step ${String(t.step_id)}: an approved provider template carries its own buttons; leave link_page out. Nothing was written.`);
          }
          if (!pageUrls.has(page)) {
            throw new Error(
              pageUrls.size
                ? `step ${String(t.step_id)}: link_page "${page.slice(0, 80)}" is not a page in this product's context. Use a url exactly as lead_card writing.context lists it, or leave it out. Nothing was written.`
                : `step ${String(t.step_id)}: this product has no company context yet, so there are no pages to link. Leave link_page out. Nothing was written.`,
            );
          }
        }
      }
      const voiceText = JSON.stringify((productDoc?.config as { voice?: unknown } | undefined)?.voice ?? {});
      if (/first person plural/i.test(voiceText)) {
        const singular = /(^|[^\w'])(I|I'm|I've|I'd|I'll|me|my|mine|myself)(?=[^\w']|$)/;
        for (const t of touches) {
          const hit = singular.exec(`${String(t.subject ?? "")}\n${String(t.body ?? "")}`);
          if (hit) {
            throw new Error(
              `step ${String(t.step_id)} speaks as one person ("${hit[2]}"). This product writes in the first person plural: we, our, the team. Rewrite it that way. Nothing was written.`,
            );
          }
        }
      }

      // What the plan already committed for each step. A touch that names no asset keeps
      // it rather than dropping it: the choice was made with the whole sequence in view,
      // and composing one message is not a reason to throw that away.
      const plan = instance.currentPlanId
        ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) })
        : null;
      // The step ids are the plan's, not the model's. A touch for a step the plan does not
      // have would render through whatever rung the ladder reached and skip the gate the
      // plan put on it, so it is refused with the list that would have been accepted.
      const planIds = new Set(((plan?.steps ?? []) as Array<Record<string, unknown>>).map((st) => Number(st.id ?? st.step_id)));
      if (planIds.size > 0) {
        for (const t of touches) {
          if (!planIds.has(Number(t.step_id))) {
            throw new Error(`step ${String(t.step_id)} is not in this person's plan; its steps are ${[...planIds].sort((a, b) => a - b).join(", ")}. Write for the step the work item names.`);
          }
        }
        // And the step must be one a session may write now: not already written, not
        // behind a gate the person has not passed, and not a family of variants the
        // engine sends itself. lead_card shows the same view, so a refusal here means the
        // card was not read.
        const priorActions = await db.collection(C.actions).find({ orgId, productId, goalInstanceId }).toArray();
        const personBand = paceBand(
          await db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) }, { projection: { temp: 1, "enrichment.form.timeline": 1 } }),
          campaignDef,
        );
        const view = await planViewFor(instance, priorActions, personBand);
        for (const t of touches) {
          const st = view?.steps.find((v) => v.step_id === Number(t.step_id));
          if (!st) continue;
          if (st.engine_renders) {
            throw new Error(`step ${st.step_id} is the engine's: it sends the next "${st.template_key}" variant itself. Write the steps after it, or nothing. Nothing was written.`);
          }
          if (st.state === "closed") {
            throw new Error(`step ${st.step_id} is behind the "${st.gate}" gate, which this person has not passed. Nothing was written.`);
          }
          if (st.state !== "open") {
            throw new Error(`step ${st.step_id} is already ${st.state} for this person. Nothing was written.`);
          }
        }
        if (view?.news_since_plan) {
          throw new Error(`news about this person reached us after this plan was written (lead_card since_last_plan). Plan again with plan_goal, built on that news, then write. Nothing was written.`);
        }
        if (view && view.waiting > 0) {
          throw new Error(`a message is already waiting for this person (${view.waiting} queued or in review). Nothing was written.`);
        }
      }

      // The whole mail, not only the part a session wrote, is what the reader gets. Rendered
      // with the template the step names, so a paragraph that fits on its own but tips the
      // finished message past a minute's read is refused before anyone reviews it.
      {
        const productForCount = await db.collection(C.products).findOne({ _id: new ObjectId(productId) });
        const reader = await db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) });
        const stepsById = new Map(
          ((plan?.steps ?? []) as Array<Record<string, unknown>>).map((st) => [Number(st.id ?? st.step_id), st]),
        );
        for (const t of touches) {
          const provider = providerTouch.get(t);
          if (provider && reader) {
            // Meta holds a template's body, variables filled, to 1024 characters.
            const whole = renderForCount((provider.blocks ?? []) as Array<Record<string, unknown>>, varsForCount(reader, productForCount), {
              slotText: String(t.body ?? "").trim(),
              ...(String(t.question ?? "").trim() ? { slots: { question: String(t.question).trim() } } : {}),
            });
            if (whole.bodyMd.length > 1024) {
              throw new Error(`step ${String(t.step_id)} renders to ${whole.bodyMd.length} characters with the "${String(provider.key)}" template; WhatsApp takes 1024. Cut the body. Nothing was written.`);
            }
            continue;
          }
          const key = String(stepsById.get(Number(t.step_id))?.templateKey ?? "");
          if (!key || !reader) continue;
          const tpl = await db
            .collection(C.templates)
            .findOne({ orgId, productId, key, status: "active" }, { sort: { scope: 1 } });
          if (!tpl) continue;
          const blocks = (tpl.blocks ?? []) as Array<Record<string, unknown>>;
          const ps = String(t.ps ?? "").trim();
          const hasPs = blocks.some((b) => String(b.type) === "slot" && String(b.name ?? "") === "ps");
          if (ps && !hasPs) {
            throw new Error(`step ${String(t.step_id)} writes a ps, but the "${key}" template has no PS line. Leave ps out. Nothing was written.`);
          }
          const sp = structuredParts.get(t);
          if (sp && !blocks.some((b) => String(b.type) === "slot" && String(b.name ?? "") === "opening")) {
            throw new Error(`step ${String(t.step_id)} is written in parts, but the "${key}" template has no place for them. Write body instead. Nothing was written.`);
          }
          if (sp?.reveal && !blocks.some((b) => String(b.type) === "slot" && String(b.name ?? "") === "reveal")) {
            throw new Error(`step ${String(t.step_id)} writes a reveal, but the "${key}" template has no place for it. Nothing was written.`);
          }
          if (sp?.receipt && !blocks.some((b) => String(b.type) === "list" && String(b.slot ?? "") === "receipt")) {
            throw new Error(`step ${String(t.step_id)} writes a receipt, but the "${key}" template has no place for it. Leave it out. Nothing was written.`);
          }
          for (const name of ["timeline", "options"] as const) {
            const given = name === "timeline" ? sp?.timeline : sp?.options;
            if (given && !blocks.some((b) => String(b.type) === "slot" && String(b.name ?? "") === name)) {
              throw new Error(`step ${String(t.step_id)} writes ${name === "options" ? "reply_options" : "timeline"}, but the "${key}" template has no place for it. Leave it out. Nothing was written.`);
            }
          }
          const rendered = renderForCount(blocks, varsForCount(reader, productForCount), {
            subject: t.subject ? String(t.subject) : undefined,
            slotText: sp ? sp.scene : String(t.body ?? ""),
            ...(sp
              ? {
                  slots: partSlots(sp, ps ? psLine(ps) : ""),
                  parts: { ...(sp.cost ? { cost: sp.cost } : {}), ...(sp.shows ? { shows: sp.shows } : {}), ...(sp.receipt ? { receipt: sp.receipt } : {}) },
                }
              : ps ? { slots: { ps: psLine(ps) } } : {}),
            ...(t.preheader ? { preheader: String(t.preheader).trim() } : {}),
          });
          const total = readableWords(rendered.bodyMd);
          // Room for the greeting, sign-off, P.S. and opt-out around a body at its type's limit.
          const typeCap = leadTypeOf(campaignDef);
          const mailCap = typeCap && LEAD_TYPE_PROFILES[typeCap].maxWords > FRAME_BODY_MAX_WORDS ? 250 : 200;
          if (total > mailCap) {
            throw new Error(`step ${String(t.step_id)} renders to ${total} words with the "${key}" template. The whole mail stays under ${mailCap}; cut your part. Nothing was written.`);
          }
        }
      }
      const plannedAsset = new Map<number, string>();
      for (const step of ((plan?.steps ?? []) as Array<Record<string, unknown>>)) {
        const assetId = String(step.asset_id ?? step.assetId ?? "");
        if (assetId) plannedAsset.set(Number(step.id ?? step.step_id), assetId);
      }

      const carried = new Map<number, string[]>();
      for (const t of touches) {
        const named = (t.asset_ids ?? null) as string[] | null;
        const planned = plannedAsset.get(Number(t.step_id));
        const ids = (named ?? (planned ? [planned] : [])).map(String).filter(Boolean);
        carried.set(Number(t.step_id), [...new Set(ids)]);
      }

      const goalDef = await db
        .collection(C.goals)
        .findOne({ orgId, productId, key: String(instance.goalKey) });

      const wanted = [...new Set([...carried.values()].flat())];
      if (wanted.length > 0) {
        const context = await assetContextFor(orgId, productId, String(instance.personId), goalDef);
        const problems: string[] = [];
        for (const t of touches) {
          const ids = carried.get(Number(t.step_id)) ?? [];
          if (ids.length === 0) continue;
          problems.push(...(await assetRefusals(orgId, productId, context, ids, String(t.channel))));
        }
        if (problems.length > 0) {
          throw new Error(`These messages cannot carry what they name:\n- ${problems.join("\n- ")}`);
        }
      }

      // Loaded once for the whole batch: what each asset claims is folded into the message
      // that carries it, so the no-repeats rule can see an argument a video made as
      // clearly as one a sentence made.
      const assetDocs = new Map(
        (await loadAssets(orgId, productId, wanted)).map((row) => [String(row._id), row]),
      );

      // A meeting time nobody has checked is a promise the calendar may not keep. Live
      // times render from the calendar only when the access asset rides along; without it
      // the skeleton asks the reader to reply with a time, and the copy must not name one.
      const dayAndTime =
        /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b[^.\n]{0,40}?\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b[^.\n]{0,40}?\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i;
      // Only an offer to meet counts. A scene set on "a normal Tuesday at 2:15pm" names a day
      // and a time too, and refusing it cost the hot emails their strongest opening.
      const offerToMeet =
        /\b(are you free|would you be free|shall we|could we|can we (talk|speak|meet|connect)|let us (talk|speak|meet)|works for you|does .{0,20} work for you|book (a|the|your)|slot|available (on|at)|meet (on|at)|call (on|at)|speak (on|at)|catch up (on|at)|demo (on|at)|walk-?through (on|at))\b/i;
      const proposesTime = (text: string) =>
        text.split(/(?<=[.!?])\s+|\n+/).some((sentence) => dayAndTime.test(sentence) && offerToMeet.test(sentence));
      for (const t of touches) {
        if (!proposesTime(String(t.body ?? "") + "\n" + String(t.ps ?? ""))) continue;
        const withCalendar = (carried.get(Number(t.step_id)) ?? []).some((id) => {
          const doc = assetDocs.get(id) as { kind?: unknown; access?: { calendar?: unknown } } | undefined;
          return String(doc?.kind) === "access" && Boolean(doc?.access?.calendar);
        });
        if (!withCalendar) {
          throw new Error(
            `step ${String(t.step_id)} proposes meeting times nobody has checked. Live times come from the calendar only when the access asset is carried; otherwise ask the reader to reply with a time that suits them. Nothing was written.`,
          );
        }
      }

      // When each message may go. The offset a session writes is measured from the
      // previous message, not from this call: composed with after_days of 0, two steps for
      // one person were due the same minute, approved together, and sent five seconds
      // apart into the same inbox. Each touch is paced from the latest of their last
      // message, anything already waiting for them, and the touch before it in this batch,
      // through the same cadence the engine uses everywhere else.
      const person = await db
        .collection(C.people)
        .findOne(
          { _id: new ObjectId(String(instance.personId)) },
          { projection: { temp: 1, lastContactedAt: 1, assignedChannelId: 1, "enrichment.form.timeline": 1 } },
        );
      const waiting = await db
        .collection(C.actions)
        .find(
          {
            orgId,
            productId,
            personId: String(instance.personId),
            status: { $in: ["queued", "awaiting_approval", "sending"] },
          },
          { projection: { dueAt: 1 } },
        )
        .toArray();
      const stamps = [person?.lastContactedAt, ...waiting.map((w) => w.dueAt)]
        .map((value) => (value ? new Date(String(value)) : null))
        .filter((date): date is Date => !!date && !Number.isNaN(date.getTime()));
      let anchor: Date | null = stamps.length > 0 ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null;
      const band = paceBand(person, goalDef);
      const cadence = goalDef?.cadenceByTemp as Record<string, CadenceBand> | undefined;
      const planOffset = new Map<number, number>();
      for (const step of ((plan?.steps ?? []) as Array<Record<string, unknown>>)) {
        planOffset.set(Number(step.id ?? step.step_id), Number(step.after_days ?? step.afterDays ?? 3));
      }
      const ordered = [...touches].sort((a, b) => Number(a.step_id) - Number(b.step_id));
      const dueAts: string[] = [];

      for (const t of ordered) {
        const dueAt = dueAtFor({
          offsetDays: Number(t.after_days ?? planOffset.get(Number(t.step_id)) ?? 3),
          band,
          lastContactedAt: anchor,
          configured: cadence,
        });
        anchor = dueAt;

        const channelKey = String(t.channel);
        // The mailbox this person already hears from, as long as the campaign still allows
        // it, and otherwise one the campaign does allow. Taking whichever healthy channel
        // came back first ignored both, so a campaign pinned to one sender could still queue
        // mail from another, and a sequence could change address halfway through.
        const allowedIds = allowedMailboxIds(goalDef?.channelIds);
        // This campaign's own mailbox for them, else whatever they hold from elsewhere.
        const held = String(instance.channelId ?? person?.assignedChannelId ?? "");
        const channel =
          (held && (allowedIds.length === 0 || allowedIds.includes(held))
            ? await db.collection(C.channels).findOne({
                orgId,
                productId,
                _id: new ObjectId(held),
                key: channelKey,
                enabled: true,
                status: "healthy",
              })
            : null) ??
          (await db.collection(C.channels).findOne({
            orgId,
            productId,
            key: channelKey,
            enabled: true,
            status: "healthy",
            ...mailboxFilter(goalDef?.channelIds),
          }));
        if (!channel) continue;
        // Remembered on the campaign, so every later step of this campaign sends from the
        // same address even if another campaign moves the person's own mailbox.
        if (String(instance.channelId ?? "") !== String(channel._id)) {
          await db
            .collection(C.goalInstances)
            .updateOne({ _id: new ObjectId(goalInstanceId) }, { $set: { channelId: String(channel._id), channelAssignedAt: new Date() } });
          instance.channelId = String(channel._id);
        }

        const actionId = new ObjectId();
        const body = String(t.body);
        const assetIds = carried.get(Number(t.step_id)) ?? [];
        const assetClaims = assetIds.flatMap((id) =>
          ((assetDocs.get(id)?.claims ?? []) as unknown[]).map(String),
        );
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
            angle: isFrameTouch(t) ? String(stepRows.get(Number(t.step_id))?.angle ?? themeSlug(String(t.theme ?? t.angle))) : String(t.angle),
            rationale: String(t.rationale),
            // The template it goes as, named on the action so the sender and the preview use
            // this one whatever the plan step said.
            ...(providerTouch.has(t) ? { templateKey: String(providerTouch.get(t)!.key) } : {}),
            ...(isFrameTouch(t)
              ? {
                  theme: String(t.theme ?? stepRows.get(Number(t.step_id))?.theme ?? t.angle),
                  hook: String(t.hook ?? stepRows.get(Number(t.step_id))?.hook ?? "") || undefined,
                  format: String(t.format),
                  formatWhy: String(t.format_why ?? "").trim(),
                  ...(Array.isArray(stepRows.get(Number(t.step_id))?.idea_refs) ? { ideaRefs: (stepRows.get(Number(t.step_id))!.idea_refs as unknown[]).map(Number) } : {}),
                }
              : {}),
            // Claude writes the slot, not the whole message: the greeting, call to action
            // and opt-out block are the template's, and are added when this renders.
            ...(structuredParts.has(t) ? { layout: structuredParts.get(t)!.layout } : {}),
            content: {
              subject: t.subject ? String(t.subject) : undefined,
              preheader: String(t.preheader ?? "").trim() || undefined,
              bodyMd: "",
              ...(structuredParts.has(t)
                ? (() => {
                    const sp = structuredParts.get(t)!;
                    return {
                      slotText: sp.scene,
                      slots: partSlots(sp, String(t.ps ?? "").trim() ? psLine(String(t.ps).trim()) : ""),
                      parts: { ...(sp.cost ? { cost: sp.cost } : {}), ...(sp.shows ? { shows: sp.shows } : {}), ...(sp.receipt ? { receipt: sp.receipt } : {}) },
                    };
                  })()
                : providerTouch.has(t)
                  ? {
                      slotText: body.trim(),
                      slots: String(t.question ?? "").trim() ? { question: String(t.question).trim() } : undefined,
                      templateParams: {
                        message: body.trim(),
                        ...(String(t.question ?? "").trim() ? { question: String(t.question).trim() } : {}),
                      },
                    }
                  : {
                    slotText: body,
                    slots: String(t.ps ?? "").trim() ? { ps: psLine(String(t.ps).trim()) } : undefined,
                  }),
              ask: String(t.ask ?? "") === "reply" ? "reply" : undefined,
              ...(String(t.link_page ?? "").trim() ? { linkPage: String(t.link_page).trim() } : {}),
              personalizationUsed: [],
              claimsMade: [...new Set([...((t.claims_made ?? []) as string[]), ...assetClaims])],
              wordCount: body.split(/\s+/).filter(Boolean).length,
            },
            assetIds,
            next: {},
            signals: [],
            idempotencyKey: `${goalInstanceId}:step:${String(t.step_id)}`,
            status: "queued",
            dueAt,
            cost: 0,
          });
          queued.push(String(actionId));
          dueAts.push(dueAt.toISOString());
        } catch (err) {
          // A duplicate key means this step is already queued — the index doing its job.
          if (!(err instanceof Error && err.message.includes("E11000"))) throw err;
        }
      }
      return { queued: queued.length, action_ids: queued, due_at: dueAts, ...(warnings.length ? { warnings } : {}) };
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
        // reviewedAt is what tells the sender a person has decided. Without it an approved
        // message returns to queued, meets the gate again on the next tick, and is held again.
        .updateMany(
          { _id: { $in: ids }, orgId: ctx.orgId, status: "awaiting_approval" },
          { $set: { status, reviewedAt: new Date() } },
        );
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
    "Store how a campaign will verify success. Each check says where its proof comes from. kind 'mcp' names a connection, a tool, its arguments and an assertion. kind 'page' names an event our own site reports for this person — use it when the finish line is a page you own, such as a booking confirmation, and there is no system to ask. kind 'reply' names the reply intents that count, for a finish line the person states in words. kind 'human' is settled by resolve_check and never by the engine — use it only when nothing can observe the thing. The engine runs these on every tick without a model, so they must be answerable without one.",
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
            kind: {
              type: "string",
              enum: ["mcp", "page", "reply", "human"],
              description: "Where the proof comes from. Defaults to mcp.",
            },
            connectionId: { type: "string", description: "mcp only." },
            tool: { type: "string", description: "mcp only." },
            args: { type: "object", description: 'mcp only. Argument name to value or $ref, e.g. {"query":"$person.email"}' },
            assert: { type: "string", description: 'mcp only. exists · count >= 2 · $.plan != trial' },
            event: {
              type: "string",
              description:
                "page only. The name the site reports, e.g. \"booked\". The page calls " +
                "{APP_URL}/api/e/<event>?p={{person_id}}&s={{visit_token}} — put both merge fields in the link " +
                "the message sends them to, so the site has them to pass on.",
            },
            intents: {
              type: "array",
              items: { type: "string" },
              description: "reply only. Which record_reply intents count, e.g. [\"interested\"].",
            },
            latch: { type: "boolean", description: "True once means true forever. Defaults true." },
          },
          required: ["key", "describedAs"],
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

    // Refused rather than stored half-formed. A check missing the fields its own kind runs
    // on is one the engine will skip silently on every tick, which reads exactly like a
    // check that keeps coming back false.
    const malformed = checks
      .map((c) => {
        const kind = String(c.kind ?? "mcp");
        if (kind === "mcp" && (!c.connectionId || !c.tool || !c.assert))
          return `${String(c.key)} is an mcp check and needs connectionId, tool and assert`;
        if (kind === "page" && !c.event) return `${String(c.key)} is a page check and needs an event name`;
        if (kind === "reply" && !Array.isArray(c.intents))
          return `${String(c.key)} is a reply check and needs the intents that count`;
        return null;
      })
      .filter(Boolean);
    if (malformed.length > 0) throw new Error(malformed.join("; "));

    // Every check is tried against two different people before it is trusted. A check that
    // answers identically for both is not looking at the person — it is describing the
    // caller's own account, and it will pass for everyone forever.
    //
    // Only the mcp ones. The other three read this product's own records, keyed by person,
    // and there is no tool to call and nothing to be blind about.
    const discrimination = await discriminationTest(
      orgId,
      productId,
      checks.filter((c) => String(c.kind ?? "mcp") === "mcp"),
    );
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
          checks: checks.map((c) => ({
            ...c,
            kind: String(c.kind ?? "mcp"),
            args: c.args ?? {},
            intents: c.intents ?? [],
            latch: c.latch ?? true,
            proposedBy: "claude",
          })),
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

    const instance = await activeInstanceFor({ orgId, productId, personId });
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
      // Maintain is the one main a product can run without: it finishes setup and learns,
      // and a product whose setup is already done loses nothing by never scheduling it.
      // LinkedIn likewise: only a product with a campaign handing LinkedIn to Claude needs it.
      .filter((r) => r.state === "late" || r.state === "never" || (!r.registered && r.routine !== "maintain" && r.routine !== "linkedin"))
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
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
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
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
    const db = await getDb();
    const { block } = await import("../../schemas/template.js");
    const { z } = await import("zod");

    // Validated here rather than at render time: a malformed block that reaches the
    // engine fails per message, hours later, in whatever words Mongo chose.
    const parsed = z.array(block).min(1).safeParse(args.blocks);
    if (!parsed.success) {
      throw new Error(`blocks are not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    // A mail asks for one thing. Two buttons split the reader between them, and the one that
    // matters loses; the second route belongs in a PS line.
    const buttons = parsed.data.filter((b) => (b as { type?: string }).type === "cta").length;
    if (buttons > 1) {
      throw new Error(`a template asks for one thing, and this one has ${buttons} buttons. Keep the one that matters and move the other into a PS line.`);
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
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
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

/**
 * The stage ladder a product's templates are measured against.
 *
 * activation_nudge, value_proof and objection were removed on 2026-09-15. Campaigns now send
 * written follow-up families instead, and the generic rungs were deleted as duplicates; left
 * here, Maintain would read them as missing and draft them back every day.
 */
const TEMPLATE_LADDER = [
  { key: "welcome", when: "the moment they arrive" },
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
    // assertProduct returns the org, not the product. Assigning it to `productId` filtered
    // every query below on productId == orgId, which matches nothing: groom was told daily
    // that this product had no channel, no source and no brand while all three were
    // healthy, and never saw the ladder rungs that really were missing.
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
    const db = await getDb();
    const s = { orgId: ctx.orgId, productId };

    const [templates, goals, sources, channels, brandSources, kit, productDoc] = await Promise.all([
      db.collection(C.templates).find(s).project({ key: 1, channel: 1, status: 1, createdAt: 1 }).toArray(),
      db.collection(C.goals).find(s).toArray(),
      db.collection(C.sources).countDocuments({ ...s, enabled: true }),
      db.collection(C.channels).countDocuments({ ...s, enabled: true }),
      db.collection(C.brandSources).countDocuments(s),
      db.collection(C.brandKits).findOne(s),
      db.collection(C.products).findOne({ _id: new ObjectId(productId) }, { projection: { "config.context": 1, "config.website": 1 } }),
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
    // The site changes — a new price, a new comparison page — and mails quoting last
    // quarter's page are wrong in a way nobody reviewing one mail would catch.
    if ((productDoc?.config as { website?: string } | undefined)?.website) {
      const context = contextOf(productDoc);
      const age = contextAgeDays(context);
      if (!context) {
        yours.push({
          gap: "no_context",
          detail: "The product's website has never been read into a company context, so writers have no page map, proof, competitors or trust claims, and every button goes to the start link.",
          fix: "read_site for the map, read_site with the selling pages a few at a time, then save_context",
        });
      } else if (age !== null && age >= CONTEXT_REFRESH_DAYS) {
        yours.push({
          gap: "context_stale",
          detail: `The website was last read ${age} days ago.`,
          fix: "read_site for the map (new pages show in_context false), read the selling pages again, then save_context with a change_note saying what moved",
        });
      }
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
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
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
    "Create a product from what you read on its website, and lay the groundwork: it reads the brand off the same site and writes the deterministic starter templates. Follow it with upsert_template to improve those, save_context for the company context (page map, proof, competitors) and draft_campaign to propose campaigns. Read the site before calling this — read_site works before the product exists, and a config guessed without reading is worse than no config.",
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
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
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

// ── company context: what the product's own website says ─────────────────────

TOOLS.push({
  name: "read_site",
  description:
    `Read a product's own website. Without pages: the site map (from its sitemap, or the home page's links) with a first guess at each page's kind, and how old the product's saved context is. With pages: the words of up to ${READ_BATCH_MAX} of those pages; call again for the next few. ` +
    "Pages built in the browser are read through a rendering reader, so a JavaScript site still returns its text. Read the pages that sell — home, features, solutions, comparisons, pricing, security, about — before save_context; blog posts rarely add anything. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string", description: "The product whose site to read. Give this or website." },
      website: { type: "string", description: "A site to read before its product exists, during onboarding." },
      pages: { type: "array", items: { type: "string" }, description: `Up to ${READ_BATCH_MAX} page URLs from the map to read now.` },
    },
  },
  async handler(args, ctx) {
    let website = str(args.website)?.trim();
    let product: Record<string, unknown> | null = null;
    if (args.product_id) {
      await assertProduct(String(args.product_id), ctx);
      const db = await getDb();
      product = await db.collection(C.products).findOne({ _id: new ObjectId(String(args.product_id)) }, { projection: { config: 1 } });
      website = String((product?.config as { website?: string } | undefined)?.website ?? "") || website;
    }
    if (!website) throw new Error("give product_id (with a website on its config) or website");
    try {
      website = new URL(/^https?:\/\//.test(website) ? website : `https://${website}`).origin;
    } catch {
      throw new Error(`"${website}" is not a website address`);
    }

    const wanted = ((args.pages ?? []) as unknown[]).map((u) => normalisePageUrl(String(u)));
    if (wanted.length) {
      if (wanted.length > READ_BATCH_MAX) throw new Error(`read at most ${READ_BATCH_MAX} pages per call; you asked for ${wanted.length}. Ask again for the rest.`);
      const off = wanted.filter((u) => !onSite(u, website!));
      if (off.length) throw new Error(`not pages of ${website}: ${off.join(", ")}. read_site reads the product's own site only.`);
      const read = await readPages(wanted);
      return {
        website,
        pages: read.map((p) => ({
          url: p.url,
          kind_guess: kindFromPath(p.url),
          ...(p.title ? { title: p.title } : {}),
          read: p.via,
          text: p.text,
        })),
        note: read.some((p) => p.via === "failed")
          ? "A page that failed could not be read either way. Leave it out of the context rather than describing it from its address."
          : undefined,
      };
    }

    const map = await siteMap(website);
    const context = contextOf(product);
    const mapped = new Set((context?.pages ?? []).map((p) => p.url));
    const age = contextAgeDays(context);
    return {
      website,
      map_from: map.from,
      page_count: map.pages.length,
      truncated: map.truncated,
      pages: map.pages.map((p) => ({ url: p.url, kind_guess: p.kind, ...(product ? { in_context: mapped.has(p.url) } : {}) })),
      context: product
        ? context
          ? { read_at: context.readAt, age_days: age, pages_read: context.pagesRead, pages_in_context: context.pages.length, due_for_refresh: (age ?? 0) >= CONTEXT_REFRESH_DAYS }
          : { none: true }
        : undefined,
      next: `Call read_site again with pages: up to ${READ_BATCH_MAX} URLs at a time, the selling pages first. Then save_context.`,
    };
  },
});

TOOLS.push({
  name: "save_context",
  description:
    "Save what the product's website says as its company context: an overview, its positioning, the page map (every selling page with its kind, a one-line summary and the segments it is written for), proof (customer quotes, case studies, logos, numbers, awards), competitors and how the product differs, security and compliance claims, and markets. " +
    "Writers read it on every lead_card, and a mail's button can go to one of these pages. Replaces the whole context, so send everything, not only what changed; on a refresh, change_note says what moved since the last read. " +
    "Proof is saved as a sample: what a marketing page shows is not a confirmed customer result, and only a person can confirm it. Write only what the pages you read say.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      overview: { type: "string", description: "Two or three sentences: what the product is and does, in the site's words." },
      positioning: { type: "string", description: "Two or three sentences: what it sets itself against, and how." },
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string", description: "Short: the page's own heading, not the site-wide <title>." },
            kind: { type: "string", enum: [...SITE_PAGE_KINDS] },
            summary: { type: "string", description: "One line: what a reader sees there." },
            segments: { type: "array", items: { type: "string" }, description: "Keys of this product's segments the page is written for." },
            competitor: { type: "string", description: "Comparison pages: the competitor's name." },
          },
          required: ["url", "title", "kind"],
        },
      },
      proof: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            who: { type: "string", description: "As the site prints it. Kept for a person to check; never put in a mail." },
            kind: { type: "string", enum: ["quote", "case", "logo", "number", "award"] },
            source: { type: "string", description: "The page it is on." },
          },
          required: ["text", "kind", "source"],
        },
      },
      competitors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            differ: { type: "array", items: { type: "string" }, description: "How the product differs, as the site claims it. One line each." },
            page: { type: "string", description: "Its comparison page, from pages." },
          },
          required: ["name", "differ"],
        },
      },
      trust: {
        type: "array",
        items: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text"] },
      },
      markets: {
        type: "object",
        properties: {
          home: { type: "string", description: "The country the company is based in, with how you know." },
          served: { type: "array", items: { type: "string" } },
          currency: { type: "string" },
          languages: { type: "array", items: { type: "string" } },
        },
      },
      pages_read: { type: "number", description: "How many pages you read for this." },
      change_note: { type: "string", description: "Required when a context already exists: what changed since the last read, in one or two lines (\"pricing page now shows $10.99 for Advanced\"), or \"no change\"." },
    },
    required: ["product_id", "overview", "positioning", "pages", "pages_read"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
    const db = await getDb();
    const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) }, { projection: { config: 1 } });
    const config = (product?.config ?? {}) as { website?: string; segments?: Array<{ key: string }> };
    const website = String(config.website ?? "");
    if (!website) throw new Error("this product has no website on its config, so there is no site to describe");
    const previous = contextOf(product);
    const changeNote = str(args.change_note)?.trim();
    if (previous && !changeNote) throw new Error('this product already has a context: say what changed since the last read in change_note ("no change" is an answer). Nothing was saved.');

    const segmentKeys = new Set((config.segments ?? []).map((s) => String(s.key)));
    const problems: string[] = [];

    const seen = new Set<string>();
    const pages = ((args.pages ?? []) as Array<Record<string, unknown>>).flatMap((p) => {
      const url = normalisePageUrl(String(p.url ?? ""));
      if (!onSite(url, website)) {
        problems.push(`page ${url} is not on ${website}`);
        return [];
      }
      if (seen.has(url)) return [];
      seen.add(url);
      const segments = ((p.segments ?? []) as unknown[]).map(String);
      const unknown = segments.filter((s) => !segmentKeys.has(s));
      if (unknown.length) problems.push(`page ${url} names segments this product does not have: ${unknown.join(", ")} (it has: ${[...segmentKeys].join(", ") || "none"})`);
      return [{
        url,
        title: String(p.title ?? "").trim(),
        kind: String(p.kind ?? ""),
        summary: String(p.summary ?? "").trim(),
        segments,
        ...(str(p.competitor)?.trim() ? { competitor: String(p.competitor).trim() } : {}),
      }];
    });
    if (!pages.length) problems.push("no pages: the page map is the point of the context");

    // A proof item a person already confirmed stays confirmed when the site still says it;
    // everything else is what a marketing page shows, and arrives as a sample.
    const confirmed = new Set((previous?.proof ?? []).filter((p) => p.status === "confirmed").map((p) => p.text.trim().toLowerCase()));
    const proof = ((args.proof ?? []) as Array<Record<string, unknown>>).flatMap((p) => {
      const source = normalisePageUrl(String(p.source ?? ""));
      if (!onSite(source, website)) {
        problems.push(`proof "${String(p.text ?? "").slice(0, 50)}" cites ${source}, which is not a page of ${website}`);
        return [];
      }
      const text = String(p.text ?? "").trim();
      return [{
        text,
        ...(str(p.who)?.trim() ? { who: String(p.who).trim() } : {}),
        kind: String(p.kind ?? ""),
        source,
        status: confirmed.has(text.toLowerCase()) ? "confirmed" : "sample",
      }];
    });

    const pageSet = new Set(pages.map((p) => p.url));
    const competitors = ((args.competitors ?? []) as Array<Record<string, unknown>>).map((c) => {
      const page = str(c.page) ? normalisePageUrl(String(c.page)) : undefined;
      if (page && !pageSet.has(page)) problems.push(`competitor ${String(c.name)} points at ${page}, which is not in pages`);
      return {
        name: String(c.name ?? "").trim(),
        differ: ((c.differ ?? []) as unknown[]).map(String).map((d) => d.trim()).filter(Boolean),
        ...(page ? { page } : {}),
      };
    });

    const trust = ((args.trust ?? []) as Array<Record<string, unknown>>).map((t) => {
      const source = str(t.source) ? normalisePageUrl(String(t.source)) : undefined;
      if (source && !onSite(source, website)) problems.push(`trust "${String(t.text).slice(0, 50)}" cites ${source}, which is not a page of ${website}`);
      return { text: String(t.text ?? "").trim(), ...(source ? { source } : {}) };
    });

    if (problems.length) throw new Error(`Nothing was saved. Fix these and send the whole context again:\n- ${problems.join("\n- ")}`);

    const at = new Date().toISOString();
    const markets = (args.markets ?? {}) as Record<string, unknown>;
    const parsed = siteContext.safeParse({
      overview: String(args.overview ?? "").trim(),
      positioning: String(args.positioning ?? "").trim(),
      pages,
      proof,
      competitors,
      trust,
      markets: {
        ...(str(markets.home) ? { home: String(markets.home) } : {}),
        served: ((markets.served ?? []) as unknown[]).map(String),
        ...(str(markets.currency) ? { currency: String(markets.currency) } : {}),
        languages: ((markets.languages ?? []) as unknown[]).map(String),
      },
      readAt: at,
      pagesRead: Math.max(0, Math.round(Number(args.pages_read ?? 0))),
      changes: [{ at, note: changeNote ?? "first read" }, ...(previous?.changes ?? [])].slice(0, 12),
    });
    if (!parsed.success) {
      throw new Error(`Nothing was saved: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }

    // The context it replaces is kept, so a refresh that dropped something can be put back.
    if (previous) {
      await db.collection(C.audit).insertOne({ orgId: ctx.orgId, at: new Date(), type: "product_context_replaced", productId, previous });
    }
    // Only this one field: re-parsing the whole config would drop keys the schema does not
    // name, and older products carry some.
    await db.collection(C.products).updateOne({ _id: new ObjectId(productId), orgId: ctx.orgId }, { $set: { "config.context": parsed.data } });

    const kinds: Record<string, number> = {};
    for (const p of parsed.data.pages) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    const untagged = parsed.data.pages.filter((p) => p.kind === "solution" && !p.segments.length).map((p) => p.url);
    return {
      saved: true,
      read_at: at,
      pages: parsed.data.pages.length,
      by_kind: kinds,
      proof: parsed.data.proof.length,
      proof_confirmed: parsed.data.proof.filter((p) => p.status === "confirmed").length,
      competitors: parsed.data.competitors.map((c) => c.name),
      trust: parsed.data.trust.length,
      ...(untagged.length ? { solution_pages_without_segment: untagged, note: "A solution page with no segment is only offered to a writer as an other page. Tag it if one of the segments fits." } : {}),
    };
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
    "What has actually worked for this product: every segment and angle with what it was sent to, what came back and what converted, the same record cut by what each message carried, plus the cross-product timing priors. Read this before plan_goal. An angle with few sends is untested, not losing — say so rather than abandoning it, and the same is true of an asset.",
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

    const [angles, assets, priors] = await Promise.all([
      anglePerformance(orgId, productId, segment),
      assetPerformance(orgId, productId, segment),
      summarisePriors(),
    ]);
    const [themes, notes] = await Promise.all([
      themePerformance(orgId, productId),
      getDb().then((db) =>
        db
          .collection(C.learningNotes)
          .find({ orgId, productId })
          .sort({ updatedAt: -1 })
          .limit(50)
          .project({ _id: 0, key: 1, group: 1, finding: 1, themes: 1, evidence: 1, status: 1, updatedAt: 1 })
          .toArray(),
      ),
    ]);

    const totalSent = angles.reduce((n, a) => n + a.sent, 0);
    const totalTrackable = angles.reduce((n, a) => n + a.trackable, 0);

    // The learning loop (off only where IDEAS_LOOP=off): invented ideas are moved on from their
    // first sends, and every idea's record is reported by number.
    let ideaTable: Array<Record<string, unknown>> | undefined;
    let ideaMoves: Awaited<ReturnType<typeof reviewInventedIdeas>> | undefined;
    if (ideasLoopOn()) {
      ideaMoves = await reviewInventedIdeas(orgId, productId);
      const db = await getDb();
      const productDoc = await db.collection(C.products).findOne({ _id: new ObjectId(productId) }, { projection: { "config.writing.ideas": 1, "config.writing.invented": 1 } });
      const byN = new Map([...ideasOf(productDoc), ...inventedOf(productDoc)].map((i) => [i.n, i]));
      const rows = await ideaPerformance(orgId, productId);
      const totals = new Map<number, { sent: number; clicked: number; replied: number; won: number; groups: Array<{ group: string; sent: number; responses: number }> }>();
      for (const r of rows) {
        const t = totals.get(r.n) ?? { sent: 0, clicked: 0, replied: 0, won: 0, groups: [] };
        t.sent += r.sent;
        t.clicked += r.clicked;
        t.replied += r.replied;
        t.won += r.won;
        t.groups.push({ group: r.group, sent: r.sent, responses: r.clicked + r.replied + r.won });
        totals.set(r.n, t);
      }
      ideaTable = [...totals.entries()]
        .map(([n, t]) => {
          const idea = byN.get(n);
          return {
            n,
            title: idea?.title ?? null,
            hook: idea?.hook ?? null,
            source: idea?.source ?? "bank",
            status: idea?.status ?? (idea?.usable === false ? "unusable" : "bank"),
            sent: t.sent,
            clicked: t.clicked,
            replied: t.replied,
            won: t.won,
            evidence: evidenceStatus(t),
            groups: t.groups.sort((a, b) => b.sent - a.sent).slice(0, 5),
          };
        })
        .sort((a, b) => b.sent - a.sent);
    }

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
      /**
       * The same sends, cut by what they carried.
       *
       * Read the pairs, not the rows: an angle appears once with an asset and once without,
       * and the difference between those two lines is the only evidence there is about
       * whether carrying something helped. A row on its own says nothing — an asset that
       * only ever rode on the best angle will look excellent and may have done nothing.
       */
      angle_with_asset: assets.map((a) => ({
        ...a,
        click_rate: a.trackable > 0 ? Number((a.clicked / a.trackable).toFixed(3)) : null,
        win_rate: a.sent > 0 ? Number((a.won / a.sent).toFixed(3)) : null,
        verdict: a.sent < MIN_SAMPLE ? "untested" : a.won > 0 ? "working" : a.clicked > 0 ? "interest, no conversion" : "no signal",
      })),
      /**
       * Written touches from the rolling planner, by lead group (segment|team size band),
       * idea, hook, format, ask and channel. Read a theme across groups before calling it a
       * winner: one that works for small teams can fail for large ones. `evidence` is guess
       * below five sends, confirmed at ten or more with two responses, retire at ten with none.
       */
      themes: themes.map((r) => ({
        ...r,
        click_rate: r.trackable > 0 ? Number((r.clicked / r.trackable).toFixed(3)) : null,
        evidence: evidenceStatus(r),
      })),
      /** What has been concluded so far, newest first. save_learning writes these. */
      learning_notes: notes,
      /**
       * Every idea that has been sent, by number: the bank's and Claude's own, with the groups
       * it went to. Present only where the learning loop is on. idea_moves lists invented ideas
       * this call moved from trial to active, or retired, and why.
       */
      ...(ideaTable ? { ideas: ideaTable, idea_moves: ideaMoves } : {}),
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
 * A conclusion drawn from results across leads, kept where the next lead's card can show it.
 *
 * The rollups say what happened; a note says what it means, in a sentence a planner can act
 * on ("founders with 11-50 people answered the evening-calls story, not the rupee maths").
 * Keyed, so the same finding is rewritten as its evidence grows rather than repeated.
 */
TOOLS.push({
  name: "save_learning",
  description:
    "Save or update one learning note: a finding from what_works about which ideas, hooks, formats or asks work for a group of leads, with the evidence behind it. Lead cards in that group show it to the next planner and writer. Use a stable key per finding so it is rewritten as evidence grows. Status: guess (under five sends), promising, confirmed (ten or more sends with at least two clicks or replies), retired (ten or more sends with none; planners are told to avoid it). Never mark confirmed or retired on less evidence than that.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      key: { type: "string", description: "Stable identifier for this finding, e.g. founder_11_50_evening_calls." },
      group: { type: "string", description: "segment|team size band as what_works shows it, or \"all\"." },
      finding: { type: "string", description: "One or two sentences a planner can act on." },
      themes: { type: "array", items: { type: "string" }, description: "The themes this finding is about, as what_works names them." },
      evidence: {
        type: "object",
        properties: { sent: { type: "number" }, clicked: { type: "number" }, replied: { type: "number" }, won: { type: "number" } },
        required: ["sent"],
      },
      status: { type: "string", enum: ["guess", "promising", "confirmed", "retired"] },
    },
    required: ["product_id", "key", "group", "finding", "evidence", "status"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const key = String(args.key ?? "").trim();
    const finding = String(args.finding ?? "").trim();
    if (!key || !finding) throw new Error("A learning note needs a key and a finding in words. Nothing was written.");
    const ev = (args.evidence ?? {}) as Record<string, unknown>;
    const evidence = {
      sent: Math.max(0, Math.round(Number(ev.sent ?? 0))),
      clicked: Math.max(0, Math.round(Number(ev.clicked ?? 0))),
      replied: Math.max(0, Math.round(Number(ev.replied ?? 0))),
      won: Math.max(0, Math.round(Number(ev.won ?? 0))),
    };
    const status = String(args.status);
    if (!["guess", "promising", "confirmed", "retired"].includes(status)) throw new Error(`status "${status}" is not one of guess, promising, confirmed, retired.`);
    // The thresholds are the whole point of a note: a "confirmed" on three sends is how one
    // lucky reply becomes every lead's opening line.
    const responses = evidence.clicked + evidence.replied;
    if (status === "confirmed" && !(evidence.sent >= 10 && responses >= 2)) {
      throw new Error(`confirmed needs ten or more sends with at least two clicks or replies; this has ${evidence.sent} sends and ${responses}. Save it as promising or guess. Nothing was written.`);
    }
    if (status === "retired" && !(evidence.sent >= 10 && responses === 0)) {
      throw new Error(`retired needs ten or more sends with no clicks or replies; this has ${evidence.sent} sends and ${responses}. Nothing was written.`);
    }
    const db = await getDb();
    const now = new Date();
    await db.collection(C.learningNotes).updateOne(
      { orgId, productId, key },
      {
        $set: {
          group: String(args.group ?? "all"),
          finding,
          themes: ((args.themes ?? []) as unknown[]).map(String).filter(Boolean),
          evidence,
          status,
          createdBy: "claude",
          updatedAt: now,
        },
        $setOnInsert: { orgId, productId, key, createdAt: now },
      },
      { upsert: true },
    );
    return { saved: key, status };
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
    "Record that a person replied, what they said and what it means. Attributes the reply to the message it answers, so what_works can tell an angle that started a conversation from one that was ignored. An answer is queued as a plain-text reply in the same conversation and held in Review for a human to release — write it as the message you would send them, not as a note about it. Recording is not deciding: use mark_state for the campaign's verdict. An intent of unsubscribe suppresses them immediately and permanently.",
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
        description: "What you are replying, grounded in what the product actually does, written as the message itself — it is queued as a plain-text reply into their thread and held for a human to approve. No greeting or sign-off is added around it. Leave it out rather than guessing; never invent a capability to close someone.",
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

    // The answer becomes a message, or it was never an answer.
    //
    // It used to be written to the event and read by nothing: a model composed a reply to a
    // real person, and the reply went nowhere. Whoever opened the notification had to write
    // it again from scratch, so the field cost a model call and bought silence.
    //
    // It is queued at awaiting_approval rather than sent. A reply is the one thing in this
    // system a human has always answered — the poller stops the sequence saying exactly
    // that — so this puts a draft in front of them instead of taking the decision away.
    // Plain text, because a conversational reply wrapped in a campaign skeleton, greeting
    // and call-to-action button reads as a machine that did not understand the question.
    const answerText = args.answer ? String(args.answer).trim() : "";
    let answerQueued: string | null = null;
    if (answerText && !suppressed) {
      answerQueued = await queueAnswer(orgId, productId, personId, answerText, at, actionId);
    }

    return {
      person_id: personId,
      intent,
      attributed_to_action: actionId,
      suppressed,
      answer_action_id: answerQueued,
      note: actionId
        ? "Attributed to their most recent send, so the angle that started this conversation gets the credit."
        : "No unanswered send to attribute this to — recorded against the person only.",
      answer_note: answerText
        ? answerQueued
          ? "Queued as a plain-text reply, held in Review. It threads under their message and sends when a human approves it."
          : "Not queued — this person has no healthy channel or open campaign to answer on."
        : undefined,
    };
  },
});

/**
 * Puts a written reply in the review queue, addressed to the conversation it answers.
 *
 * Held rather than sent: everything upstream of here treats a reply as the moment a human
 * takes over — the inbound poller skips their queued messages with "waiting on a human
 * answer" and notifies the owner within the minute — so this hands that person a draft, not
 * a decision already made.
 *
 * Returns the action id, or null when there is nothing to answer on: no healthy channel, or
 * no open campaign to hang it from. Silent failure here would be the same bug this replaces.
 */
async function queueAnswer(
  orgId: string,
  productId: string,
  personId: string,
  answer: string,
  at: Date,
  repliedToActionId: string | null,
): Promise<string | null> {
  const db = await getDb();

  // The channel their last message went out on, so the answer arrives from the address they
  // are already talking to rather than whichever channel happens to be first.
  const lastSend = repliedToActionId
    ? await db.collection(C.actions).findOne({ _id: new ObjectId(repliedToActionId) })
    : await db
        .collection(C.actions)
        .find({ orgId, productId, personId, status: { $in: ["sent", "dispatched"] } })
        .sort({ sentAt: -1 })
        .limit(1)
        .next();

  const instance =
    (lastSend?.goalInstanceId &&
      (await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(lastSend.goalInstanceId)) }))) ||
    (await activeInstanceFor({ orgId, productId, personId, channel: lastSend?.channel ? String(lastSend.channel) : undefined }));
  if (!instance) return null;

  // Their own thread first. With no send to answer, the campaign's mailboxes decide: an
  // answer from an address this campaign never sends from is a stranger joining in.
  const answerGoal = await db.collection(C.goals).findOne({ orgId, productId, key: String(instance.goalKey) });
  const channel =
    (lastSend?.channelId
      ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(lastSend.channelId)), enabled: true, status: "healthy" })
      : instance.channelId
        ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(instance.channelId)), enabled: true, status: "healthy" })
        : null) ??
    (await db.collection(C.channels).findOne({
      orgId,
      productId,
      key: "email",
      enabled: true,
      status: "healthy",
      ...mailboxFilter(answerGoal?.channelIds),
    }));
  if (!channel) return null;

  const actionId = new ObjectId();
  try {
    await db.collection(C.actions).insertOne({
      _id: actionId,
      orgId,
      productId,
      goalInstanceId: String(instance._id),
      personId,
      channel: String(channel.key),
      channelId: String(channel._id),
      angle: "reply",
      rationale: "Answers what they wrote. Queued by the React routine, held for a human.",
      content: {
        bodyMd: "",
        slotText: answer,
        personalizationUsed: [],
        claimsMade: [],
        wordCount: answer.split(/\s+/).filter(Boolean).length,
      },
      // A conversational reply is not a campaign touch, and the skeleton's greeting and
      // call-to-action button would make it read like one.
      format: "text",
      assetIds: [],
      next: {},
      signals: [],
      // One answer per reply. Two runs reading the same unhandled reply must not send the
      // person two answers to one question.
      idempotencyKey: `${String(instance._id)}:reply:${at.getTime()}`,
      status: "awaiting_approval",
      dueAt: at,
      cost: 0,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("E11000")) return null;
    throw err;
  }
  return String(actionId);
}

/**
 * AI calls that connected and have not been read yet.
 *
 * A call is the one touch that comes back as a conversation rather than a signal: the
 * transcript is the lead's own words, as much as a reply is. The reconciler stores it on the
 * action; this hands the unread ones to a session so each gets an outcome before the next
 * step for that lead is planned.
 */
TOOLS.push({
  name: "pull_calls",
  description:
    "AI calls that connected and have no outcome recorded yet, oldest first: who was called, the brief the agent spoke from, how long it lasted, the transcript and the recording. Read each transcript, then call record_call with what it came to. Calls that did not connect are not returned — they are already marked failed on the lead with the reason (no answer, busy). Use lead_card for who the person is.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      limit: { type: "number", description: "Default 10, at most 25." },
    },
    required: ["product_id"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const limit = Math.min(25, Math.max(1, Number(args.limit ?? 10)));

    const calls = await db
      .collection(C.actions)
      .find({
        orgId,
        productId,
        channel: "voice",
        status: "sent",
        "call.connected": true,
        "call.outcome": { $exists: false },
      })
      .sort({ sentAt: 1 })
      .limit(limit)
      .toArray();
    const people = await db
      .collection(C.people)
      .find({ _id: { $in: calls.map((a) => new ObjectId(String(a.personId))) } }, { projection: { name: 1 } })
      .toArray();
    const names = new Map(people.map((p) => [String(p._id), p.name]));

    return {
      calls: calls.map((a) => {
        const call = (a.call ?? {}) as Record<string, unknown>;
        return {
          action_id: String(a._id),
          person_id: String(a.personId),
          name: names.get(String(a.personId)) ?? null,
          called_at: a.sentAt,
          duration_sec: call.durationSec ?? null,
          brief: (a.content as { bodyMd?: string } | undefined)?.bodyMd ?? "",
          summary: call.summary ?? null,
          transcript: String(call.transcript ?? "").slice(0, 8000),
          recording_url: call.recordingUrl ?? null,
          extracted: call.extracted ?? null,
        };
      }),
    };
  },
});

/**
 * What a call came to, written onto the call itself.
 *
 * The same boundary as record_reply: this records what happened and what it means for the
 * lead, and the campaign's verdict stays with mark_state. The exception is being asked not
 * to be called again, which is not a judgement call — the number is suppressed on the spot.
 */
TOOLS.push({
  name: "record_call",
  description:
    "Record what an AI call came to, from its transcript. The outcome and the one-line reason are shown under the call on the lead page, so write the reason for a human: what they said, not your analysis. do_not_call suppresses their number immediately and cancels their queued calls. A callback is recorded, not scheduled — plan the next call with plan_goal and compose_batch. Use mark_state for the campaign's verdict.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      action_id: { type: "string", description: "The call, from pull_calls." },
      outcome: {
        type: "string",
        enum: ["interested", "callback", "not_now", "not_interested", "wrong_person", "voicemail", "do_not_call"],
      },
      reason: {
        type: "string",
        description:
          'One sentence a human reads on the lead page, e.g. "Asked for a demo next week; tracks attendance in Excel today."',
      },
      callback_at: {
        type: "string",
        description: "When they asked to be called back, ISO 8601 with its offset. Only for callback.",
      },
      objection: {
        type: "string",
        description: "The objection in one line, if there is one. Kept on the person and carried into every later campaign.",
      },
      follow_up_email: {
        type: "object",
        description:
          "The email they were promised on the call — usually the free trial link. Written as the email itself, professional register, no greeting-card fluff; put {{trial_link}} where the link goes and it is filled in per person. Queued on the product's email channel and released by the campaign's approval setting. Leave it out when nothing was promised.",
        properties: {
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["subject", "body"],
      },
    },
    required: ["product_id", "action_id", "outcome", "reason"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    if (!ObjectId.isValid(String(args.action_id))) throw new Error("action_id is not a call id");
    const action = await db
      .collection(C.actions)
      .findOne({ _id: new ObjectId(String(args.action_id)), orgId, productId, channel: "voice" });
    const call = action?.call as { endedAt?: Date } | undefined;
    if (!action || !call) throw new Error("no finished call with that id");

    const outcome = String(args.outcome);
    const personId = String(action.personId);
    const at = new Date();
    const callbackAt = args.callback_at ? new Date(String(args.callback_at)) : undefined;
    if (callbackAt && Number.isNaN(callbackAt.getTime())) throw new Error("callback_at is not a date");

    await db.collection(C.actions).updateOne(
      { _id: action._id },
      {
        $set: {
          "call.outcome": outcome,
          "call.reason": String(args.reason),
          "call.recordedAt": at,
          ...(callbackAt ? { "call.callbackAt": callbackAt } : {}),
        },
      },
    );

    // A voicemail or the wrong person is not this lead saying anything.
    if (outcome !== "voicemail" && outcome !== "wrong_person") {
      await db.collection(C.people).updateOne({ _id: new ObjectId(personId) }, { $set: { lastSignalAt: call.endedAt ?? at } });
    }
    // Guarded on temp existing, for the reason record_reply gives.
    if (outcome === "interested" || outcome === "callback") {
      await db
        .collection(C.people)
        .updateOne({ _id: new ObjectId(personId), temp: { $exists: true } }, { $set: { "temp.computedAt": new Date(0) } });
    }
    if (args.objection) {
      await db.collection(C.people).updateOne(
        { _id: new ObjectId(personId) },
        { $push: { objections: { text: String(args.objection), at, source: "call" } } as never },
      );
    }

    let suppressed = false;
    if (outcome === "do_not_call") {
      const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) });
      const phone = person ? addressFor(person, "voice") : "";
      if (phone) {
        await suppress(orgId, phone, "asked not to be called");
        suppressed = true;
      }
      await db.collection(C.actions).updateMany(
        { orgId, productId, personId, channel: "voice", status: { $in: ["queued", "awaiting_approval", "held"] } },
        { $set: { status: "skipped", skipReason: "asked not to be called" } },
      );
    }

    // What the agent promised on the call, sent where a link can be clicked. Queued rather
    // than sent: the campaign's approval setting decides, as it does for every message.
    let followUpActionId: string | null = null;
    const followUp = args.follow_up_email as { subject?: unknown; body?: unknown } | undefined;
    if (followUp?.body && outcome !== "do_not_call") {
      const [person, product] = await Promise.all([
        db.collection(C.people).findOne({ _id: new ObjectId(personId) }),
        db.collection(C.products).findOne({ _id: new ObjectId(productId) }),
      ]);
      // The mailbox they already hear from, else the one this product sends from now. The
      // first healthy email channel Mongo returned was a retired mailbox the first time this
      // ran, because retired mailboxes stay on as rows.
      const lastUsedEmail = async (filter: Record<string, unknown>) => {
        const last = await db
          .collection(C.actions)
          .find({ orgId, productId, channel: "email", status: "sent", ...filter })
          .sort({ sentAt: -1 })
          .limit(1)
          .next();
        return last?.channelId
          ? db
              .collection(C.channels)
              .findOne({ _id: new ObjectId(String(last.channelId)), key: "email", enabled: true, status: "healthy" })
          : null;
      };
      // Their own mailbox first; failing that, one this campaign is allowed to send from.
      const callGoal = await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(action.goalInstanceId)) });
      const callGoalDef = callGoal
        ? await db.collection(C.goals).findOne({ orgId, productId, key: String(callGoal.goalKey) })
        : null;
      const emailChannel =
        (await lastUsedEmail({ personId })) ??
        (callGoal?.channelId
          ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(callGoal.channelId)), key: "email", enabled: true, status: "healthy" })
          : null) ??
        (await lastUsedEmail({})) ??
        (await db.collection(C.channels).findOne({
          orgId,
          productId,
          key: "email",
          enabled: true,
          status: "healthy",
          ...mailboxFilter(callGoalDef?.channelIds),
        }));
      if (person?.primaryEmail && emailChannel) {
        const vars = varsForCount(person, product) as unknown as Record<string, string>;
        const body = String(followUp.body).replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => vars[key] ?? whole);
        const id = new ObjectId();
        try {
          await db.collection(C.actions).insertOne({
            _id: id,
            orgId,
            productId,
            goalInstanceId: String(action.goalInstanceId),
            personId,
            channel: "email",
            channelId: String(emailChannel._id),
            // A plain answer rather than a campaign skeleton: it continues a conversation
            // they have just had, and fireDue renders "reply" as exactly the words given.
            angle: "reply",
            rationale: "Sends what the AI call promised them. Queued by record_call.",
            content: {
              subject: String(followUp.subject ?? "").trim() || "Your TeamGrid free trial",
              bodyMd: "",
              slotText: body,
              personalizationUsed: [],
              claimsMade: [],
              wordCount: body.split(/\s+/).filter(Boolean).length,
            },
            format: "text",
            assetIds: [],
            next: {},
            signals: [],
            // One follow-up per call, however many runs read it.
            idempotencyKey: `${String(action.goalInstanceId)}:call_followup:${String(action._id)}`,
            status: "queued",
            dueAt: at,
            cost: 0,
          });
          followUpActionId = String(id);
        } catch (err) {
          if (!(err instanceof Error && err.message.includes("E11000"))) throw err;
        }
      }
    }

    return {
      action_id: String(action._id),
      person_id: personId,
      outcome,
      suppressed,
      follow_up_action_id: followUpActionId,
      ...(followUp?.body && !followUpActionId
        ? { follow_up_note: "Not queued: no email address on this person, no healthy email channel, or already queued for this call." }
        : {}),
      note:
        outcome === "callback"
          ? "Recorded. Nothing is scheduled yet: plan the callback with plan_goal and compose its brief with compose_batch."
          : "Recorded on the call. Use mark_state if this settles the campaign.",
    };
  },
});

/**
 * The worker contract: what a sub-routine is allowed to work on, and how it hands it back.
 *
 * Routines used to choose their own work by sweeping the database, which put two decisions
 * in one place — what needs doing, and whose turn it is. The second is arithmetic, it has
 * to happen every minute rather than every hour, and getting it wrong is invisible: the
 * old sweep read two hundred rows in disk order and reported an empty queue while thousands
 * waited. Both decisions now belong to the engine, and a routine asks only for its slice.
 */
TOOLS.push({
  name: "next_work",
  description:
    "Claim the next batch of work of one kind. The engine has already decided what is ready and divided it fairly across products and campaigns, so what comes back is yours to do now — urgent first, then whoever has waited longest. Every item is leased: finish it with finish_work, or it returns to the pool on its own when the lease expires. Kinds: classify (people nobody has read), compose (the next message for someone who has earned a written one), escalate (someone who just clicked or replied), monitor (is this person done), playbook (a segment with no sequence), plan (one lead's own plan, in a campaign that plans each lead), groom (setup).",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...THINKING_KINDS] },
      limit: { type: "number", description: "Max items. Default 25, ceiling 200." },
      product_id: { type: "string", description: "Narrow to one product. Omit to work across everything you own." },
    },
    required: ["kind"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const kind = String(args.kind) as ThinkingKind;
    if (!(THINKING_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown kind "${kind}"`);
    const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 200);

    const claimed = await claimBatch(ctx.orgId, kind, limit);
    const wanted = str(args.product_id);
    // Filtered after the claim rather than before it: narrowing the lease query by product
    // would let a session quietly take only its favourite product's work and leave the rest
    // leased to nobody. Anything not wanted is released immediately.
    let mine = wanted ? claimed.filter((j) => String(j.productId ?? "") === wanted) : claimed;
    const notMine = claimed.filter((j) => !mine.includes(j));
    if (notMine.length) await releaseAll(notMine.map((j) => j._id));

    // A compose job whose person already has a message waiting is finished here, not
    // handed out. The engine queues the steps that are its own (a welcome variant, say)
    // after the job was raised, and a session given such a job would write a second
    // message for somebody who has not yet received the first.
    let stale = 0;
    if (kind === "compose") {
      const keep = [];
      for (const job of mine) {
        const goalInstanceId = str((job.payload as Record<string, unknown> | undefined)?.goalInstanceId);
        const waiting = goalInstanceId
          ? await db.collection(C.actions).countDocuments({ orgId: ctx.orgId, goalInstanceId, status: { $in: ["queued", "awaiting_approval", "sending"] } })
          : 0;
        if (waiting > 0) {
          await completeAll([job._id]);
          stale++;
        } else {
          keep.push(job);
        }
      }
      mine = keep;
    }

    // A plan job whose lead already has a plan written for them is finished here too. The
    // engine asks on the minute clock, and a session may have planned the lead in between.
    if (kind === "plan") {
      const keep = [];
      for (const job of mine) {
        const goalInstanceId = str((job.payload as Record<string, unknown> | undefined)?.goalInstanceId);
        const instance = goalInstanceId && ObjectId.isValid(goalInstanceId)
          ? await db.collection(C.goalInstances).findOne({ _id: new ObjectId(goalInstanceId) }, { projection: { currentPlanId: 1, status: 1, goalKey: 1, productId: 1 } })
          : null;
        const plan = instance?.currentPlanId && ObjectId.isValid(String(instance.currentPlanId))
          ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) }, { projection: { createdBy: 1, createdAt: 1, rolling: 1 } })
          : null;
        const goalRow = instance
          ? await db.collection(C.goals).findOne({ orgId: ctx.orgId, productId: String(instance.productId), key: String(instance.goalKey) }, { projection: { perLeadPlan: 1 } })
          : null;
        // In a campaign that plans a touch or two at a time, a lead is asked about again at
        // every checkpoint, so the question is only answered by a plan written after it.
        const answered = isRolling(goalRow)
          ? Boolean(plan && isRollingPlan(plan) && plan.createdAt && new Date(String(plan.createdAt)) > new Date(String(job.createdAt ?? 0)))
          : Boolean(plan && plan.createdBy !== "playbook");
        if (!instance || instance.status !== "active" || answered) {
          await completeAll([job._id]);
          stale++;
        } else {
          keep.push(job);
        }
      }
      mine = keep;
    }

    const items = [];
    for (const job of mine) {
      const payload = (job.payload ?? {}) as Record<string, unknown>;
      const personId = str(payload.personId);
      const person = personId
        ? await db.collection(C.people).findOne({ _id: new ObjectId(personId) })
        : null;
      // Setup items about an asset carry the asset rather than a person.
      const assetId = str(payload.assetId);
      const assetRow = assetId && ObjectId.isValid(assetId)
        ? await db.collection(C.assets).findOne({ _id: new ObjectId(assetId), orgId: ctx.orgId }, { projection: { name: 1, kind: 1, status: 1, file: 1 } })
        : null;

      // Compact by design. A full lead card runs to roughly four hundred tokens and a
      // session's context is what bounds how many people it can get through in an hour —
      // a hundred cards is a full window, a hundred rows like these is a fifth of one.
      // Anything a particular person turns out to need is one lead_card call away.
      items.push({
        job_id: String(job._id),
        product_id: job.productId ?? null,
        campaign: job.campaignKey ?? null,
        urgent: Number(job.priority ?? 1) === PRIORITY.urgent,
        waiting_minutes: Math.round((Date.now() - new Date(String(job.dueAt)).getTime()) / 60_000),
        reason: payload.reason ?? null,
        goal_instance_id: payload.goalInstanceId ?? null,
        asset: assetRow
          ? {
              id: String(assetRow._id),
              name: assetRow.name ?? null,
              kind: assetRow.kind ?? null,
              status: assetRow.status ?? null,
              url: (assetRow.file as { url?: string } | undefined)?.url ?? null,
            }
          : null,
        person: person
          ? {
              id: String(person._id),
              name: person.name ?? null,
              role: person.role ?? null,
              company: person.companyDomain ?? null,
              email_kind: person.emailKind ?? null,
              segment: (person.belief as { segment?: string } | undefined)?.segment ?? null,
              temperature: (person.temp as { band?: string } | undefined)?.band ?? null,
              arrivals: ((person.arrivals ?? []) as Array<{ kind?: string }>).map((a) => a.kind ?? "unknown"),
            }
          : null,
      });
    }

    const waiting = await db
      .collection(C.workQueue)
      .countDocuments({ orgId: ctx.orgId, kind, status: "queued" });

    return {
      kind,
      claimed: items.length,
      // Said plainly rather than left to be inferred from an empty page. A backlog nobody
      // can see is how this system lost nine thousand people once already.
      still_waiting: waiting,
      // Jobs finished on the spot because a message was already waiting for that person.
      stale_finished: stale,
      items,
      note:
        items.length === 0
          ? waiting > 0
            ? `Nothing is ready yet; ${waiting} waiting for the dispatcher's next round. Stop and report that.`
            : "Nothing waiting. Stop."
          : "Finish these with finish_work. Anything you do not finish returns to the pool when the lease expires.",
    };
  },
});

// ── describing assets ─────────────────────────────────────────────────────────

/** The picture types a model can actually look at. An SVG or a PDF is described from its words. */
const VIEWABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

TOOLS.push({
  name: "view_asset",
  description:
    "Look at one asset before describing it: the file itself where it is a picture, its current fields, and the product's segments and voice. Use it for the describe_asset items next_work(\"groom\") hands out.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      asset_id: { type: "string" },
    },
    required: ["product_id", "asset_id"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
    const db = await getDb();
    const assetId = String(args.asset_id);
    const row = ObjectId.isValid(assetId)
      ? await db.collection(C.assets).findOne({ _id: new ObjectId(assetId), orgId: ctx.orgId, productId })
      : null;
    if (!row) throw new Error(`asset ${assetId} not found in this product`);

    const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId: ctx.orgId }, { projection: { name: 1, config: 1 } });
    const config = (product?.config ?? {}) as {
      oneLiner?: string;
      voice?: { tone?: string };
      segments?: Array<{ key: string; name?: string; detect?: string; pain?: string; objections?: string[] }>;
    };
    const file = (row.file ?? {}) as { url?: string; fileId?: string; mime?: string; thumbUrl?: string };
    const description = (row.description ?? {}) as { autoTier?: boolean };

    // The picture itself, when there is one to show. An uploaded file is read from our own
    // store; a linked one is fetched, because a model told only "screenshot.png" describes
    // what the filename suggests rather than what the image contains.
    let image: { data: string; mimeType: string } | null = null;
    let unseen: string | null = null;
    const pictureUrl = row.kind === "image" ? file.url : row.kind === "video" ? file.thumbUrl : undefined;
    if (row.kind === "image" && file.fileId) {
      const stored = await readAssetFile(file.fileId);
      if (stored && VIEWABLE_IMAGE.test(stored.mime)) image = { data: stored.data.toString("base64"), mimeType: stored.mime };
      else unseen = stored ? `the uploaded file is ${stored.mime}, which cannot be shown` : "the uploaded file is missing";
    } else if (pictureUrl) {
      try {
        const res = await fetch(pictureUrl, { signal: AbortSignal.timeout(10_000) });
        const type = ((res.headers.get("content-type") ?? "").split(";")[0] ?? "").trim().toLowerCase();
        const data = Buffer.from(await res.arrayBuffer());
        if (res.ok && VIEWABLE_IMAGE.test(type) && data.byteLength <= MAX_ASSET_FILE_BYTES) {
          image = { data: data.toString("base64"), mimeType: type };
        } else {
          unseen = `fetching ${pictureUrl} returned ${res.status} ${type || "no type"}, ${data.byteLength} bytes`;
        }
      } catch (err) {
        unseen = `could not fetch ${pictureUrl}: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (!["quote", "stat", "access"].includes(String(row.kind))) {
      unseen = "this kind is not a picture; describe it from its name, its link and what that page is about";
    }

    const facts = {
      asset_id: assetId,
      name: row.name,
      kind: row.kind,
      status: row.status,
      tier: row.tier,
      tier_is_automatic: description.autoTier === true,
      url: file.url ?? null,
      mime: file.mime ?? null,
      text: row.text ?? null,
      attribution: row.attribution ?? null,
      already_written: {
        use_when: row.useWhen || null,
        proves: row.proves || null,
        one_line: row.oneLine || null,
        claims: row.claims ?? [],
        for_segment: row.forSegment ?? [],
        answers: row.answers ?? [],
        tags: row.tags ?? [],
      },
      product: {
        name: product?.name ?? null,
        one_liner: config.oneLiner ?? null,
        voice: config.voice?.tone ?? null,
        segments: (config.segments ?? []).map((s) => ({ key: s.key, name: s.name, detect: s.detect, pain: s.pain, objections: s.objections })),
      },
      file_shown: Boolean(image),
      ...(unseen ? { file_not_shown: unseen } : {}),
      note: "Anything under already_written is kept as the person wrote it; describe_asset fills only the empty fields.",
    };

    const content: MediaResult["content"] = [{ type: "text", text: JSON.stringify(facts, null, 2) }];
    if (image) content.push({ type: "image", ...image });
    const result: MediaResult = {
      media: true,
      content,
      logged: { asset_id: assetId, name: row.name, kind: row.kind, file_shown: Boolean(image), ...(unseen ? { file_not_shown: unseen } : {}) },
    };
    return result;
  },
});

TOOLS.push({
  name: "describe_asset",
  description:
    "Write the sentences a composer chooses an asset by, after looking at it with view_asset. Fills only what is still empty, so a person's own wording is never overwritten, and finishes the asset's groom item. one_line is printed to readers — as a picture's alt text or a link's words — so it follows the product voice. Set looks_unsafe, with a note, when the file shows a real person's name, private data or an incident: the asset goes back to draft for a person to replace.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      asset_id: { type: "string" },
      use_when: { type: "string", description: "The reader and the moment it suits, in plain words." },
      proves: { type: "string", description: "The one thing a reader believes afterwards that they did not before." },
      one_line: { type: "string", description: "The sentence that introduces it in an email." },
      claims: { type: "array", items: { type: "string" }, description: "Claims the asset makes on its own." },
      for_segment: { type: "array", items: { type: "string" }, description: "Segment keys from the product; empty means every segment." },
      answers: { type: "array", items: { type: "string" }, description: "Objections it answers, in the words the product's segments use." },
      tags: { type: "array", items: { type: "string" } },
      tier: { type: "string", enum: ["A", "B", "C", "D"], description: "Applied only when the person left the tier on automatic." },
      looks_unsafe: { type: "boolean" },
      note: { type: "string", description: "Required with looks_unsafe: what a person should look at." },
    },
    required: ["product_id", "asset_id", "use_when", "proves", "one_line"],
  },
  async handler(args, ctx) {
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);
    const db = await getDb();
    const assetId = String(args.asset_id);
    const row = ObjectId.isValid(assetId)
      ? await db.collection(C.assets).findOne({ _id: new ObjectId(assetId), orgId: ctx.orgId, productId })
      : null;
    if (!row) throw new Error(`asset ${assetId} not found in this product`);

    const sentence = (value: unknown, field: string, max: number) => {
      const text = String(value ?? "").trim();
      if (!text) throw new Error(`${field} is empty`);
      if (text.length > max) throw new Error(`${field} is ${text.length} characters; keep it under ${max}`);
      return text;
    };
    const useWhen = sentence(args.use_when, "use_when", 400);
    const proves = sentence(args.proves, "proves", 300);
    const oneLine = sentence(args.one_line, "one_line", 160);
    const listOf = (value: unknown) => ((value ?? []) as unknown[]).map((v) => String(v).trim()).filter(Boolean);

    const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId: ctx.orgId }, { projection: { config: 1 } });
    const known = new Set(((product?.config as { segments?: Array<{ key: string }> } | undefined)?.segments ?? []).map((s) => s.key));
    const segments = listOf(args.for_segment);
    const stray = segments.filter((s) => !known.has(s));
    if (stray.length) {
      throw new Error(`for_segment names ${stray.join(", ")}, which this product does not have. Use ${[...known].join(", ")}, or none for every segment.`);
    }

    const unsafe = args.looks_unsafe === true;
    const note = str(args.note)?.trim().slice(0, 500) || undefined;
    if (unsafe && !note) throw new Error("looks_unsafe needs a note saying what a person should look at");

    const empty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) ? value.length === 0 : String(value).trim() === "");
    const set: Record<string, unknown> = {};
    const kept: string[] = [];
    const fill = (field: string, value: unknown) => {
      if (empty(row[field])) set[field] = value;
      else kept.push(field);
    };
    fill("useWhen", useWhen);
    fill("proves", proves);
    fill("oneLine", oneLine);
    fill("claims", listOf(args.claims));
    fill("forSegment", segments);
    fill("answers", listOf(args.answers));
    fill("tags", listOf(args.tags));

    const prior = (row.description ?? {}) as Record<string, unknown>;
    const tier = str(args.tier);
    if (tier && prior.autoTier === true && ["A", "B", "C", "D"].includes(tier)) set.tier = tier;

    set.description = {
      ...prior,
      state: unsafe ? "failed" : "done",
      by: "claude",
      doneAt: new Date(),
      ...(note ? { note } : {}),
    };
    // Back to draft rather than archived: a person has to see it to replace the file, and a
    // draft is where the Brand page shows what still needs them.
    if (unsafe) set.status = "draft";
    await db.collection(C.assets).updateOne({ _id: row._id }, { $set: set });

    const open = await db
      .collection(C.workQueue)
      .find({ orgId: ctx.orgId, kind: "groom", subjectId: `asset:${assetId}`, status: { $in: ["queued", "ready", "running"] } })
      .project({ _id: 1 })
      .toArray();
    await completeAll(open.map((j) => j._id));

    return {
      asset_id: assetId,
      state: unsafe ? "failed" : "done",
      written: Object.keys(set).filter((k) => k !== "description"),
      kept_as_written: kept,
      status: unsafe ? "draft" : row.status,
      finished_jobs: open.length,
      note: unsafe
        ? "Returned to draft with your note; the Brand page shows it as needing a person."
        : row.status === "active"
          ? "Active and described, so campaigns may offer it from now on."
          : "Described, but still a draft: a person activates it on the Brand page.",
    };
  },
});

TOOLS.push({
  name: "finish_work",
  description:
    "Mark claimed work done. Anything you leave unfinished returns to the pool on its own, so a session that runs out of room should simply stop rather than reporting work it did not do.",
  inputSchema: {
    type: "object",
    properties: {
      job_ids: { type: "array", items: { type: "string" } },
    },
    required: ["job_ids"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const ids = ((args.job_ids ?? []) as unknown[]).map((id) => String(id)).filter((id) => ObjectId.isValid(id));
    if (ids.length === 0) return { finished: 0 };

    // Scoped to the caller's org before anything is written. A job id is guessable, and
    // "finish" on somebody else's queue would drop their work silently.
    const own = await db
      .collection(C.workQueue)
      .find({ _id: { $in: ids.map((id) => new ObjectId(id)) }, orgId: ctx.orgId })
      .project({ _id: 1 })
      .toArray();

    await completeAll(own.map((j) => j._id));
    return { finished: own.length };
  },
});

TOOLS.push({
  name: "backlog_report",
  description:
    "What is waiting, per product and campaign, and how long it has been waiting. Read this when you cannot finish everything, so what you leave behind is stated rather than silent.",
  inputSchema: { type: "object", properties: {} },
  async handler(_args, ctx) {
    const rows = await backlog(ctx.orgId);
    const stuck = rows.filter((r) => r.oldestMinutes > 120);
    return {
      lanes: rows,
      note: stuck.length
        ? `${stuck.length} queue${stuck.length === 1 ? "" : "s"} have work older than two hours. Say so in your run summary — a backlog nobody reports is a backlog nobody fixes.`
        : "Nothing has been waiting more than two hours.",
    };
  },
});

TOOLS.push({
  name: "upsert_playbook",
  description:
    "Write the sequence one segment of one campaign runs: the ordered steps, each with a channel, an angle, a reason and an offset in days. Written once and copied onto everybody in that segment as they arrive, so it is worth more care than any single message — and so a person has a working sequence within seconds of landing, before any session has looked at them. Offsets are intentions: the engine paces the real send from the person's temperature. Around a third of the steps must use an angle that is not already proven for this segment, and a sequence of three or more steps may not use one angle throughout; both are refused rather than warned about.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      goal_key: { type: "string", description: "The campaign this sequence belongs to." },
      segment_key: {
        type: "string",
        description:
          'The segment that runs it, or "default" for the sequence everybody runs until they are classified. Must be a segment the product declares.',
      },
      rationale: { type: "string", description: "Why this sequence, or what the previous one got wrong." },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "number" },
            offset_days: { type: "number", description: "Days after the previous touch, as an intention." },
            channel: { type: "string" },
            angle: { type: "string" },
            why: { type: "string" },
            template_key: { type: "string", description: "Optional. Left unset, send time picks the ladder rung. A template family name (e.g. \"welcome\") picks the next variant this person has not had yet." },
            gate: { type: "string", enum: ["no_open", "no_click", "warm", "cold"], description: "Optional. no_open: only while nothing we sent was opened. no_click: only while nothing was clicked. warm: only once warm or hot. cold: only while neither. A failed gate skips the step for good." },
          },
          required: ["id", "offset_days", "channel", "angle", "why"],
        },
      },
    },
    required: ["product_id", "goal_key", "segment_key", "steps"],
  },
  async handler(args, ctx) {
    const db = await getDb();
    const productId = String(args.product_id);
    await assertProduct(productId, ctx);

    const goalKey = String(args.goal_key);
    const goal = await db.collection(C.goals).findOne({ orgId: ctx.orgId, productId, key: goalKey });
    if (!goal) throw new Error(`campaign "${goalKey}" not found for this product`);

    const segmentKey = String(args.segment_key);
    // "default" is not a segment, it is the absence of one, and it is the sequence every
    // single person runs first — nobody is classified at the moment they arrive.
    if (segmentKey !== "default") {
      const allowed = await allowedSegments(ctx.orgId, productId);
      if (!allowed.includes(segmentKey)) {
        throw new Error(
          `unknown segment "${segmentKey}". This product accepts: ${allowed.join(", ")}, or "default". ` +
            `A playbook for a segment nothing classifies into would never run.`,
        );
      }
    }

    const steps = ((args.steps ?? []) as Array<Record<string, unknown>>).map((step, index) => ({
      id: Number(step.id ?? index + 1),
      offsetDays: Number(step.offset_days ?? 3),
      channel: String(step.channel ?? "email"),
      angle: String(step.angle ?? ""),
      why: String(step.why ?? ""),
      templateKey: step.template_key ? String(step.template_key) : undefined,
      gate: step.gate ? String(step.gate) : undefined,
    }));
    if (steps.length === 0) throw new Error("a playbook needs at least one step");

    const allowedChannels = (goal.allowedChannels ?? ["email"]) as string[];
    const wrongChannel = steps.find((s) => !allowedChannels.includes(s.channel));
    if (wrongChannel) {
      throw new Error(
        `step ${wrongChannel.id} uses "${wrongChannel.channel}", which campaign "${goalKey}" does not allow. ` +
          `Allowed: ${allowedChannels.join(", ")}.`,
      );
    }

    // A named template has to exist on the channel its step sends on. Unchecked, a WhatsApp
    // playbook named "hot_lead_followup" — no template anywhere — on all five steps, was
    // stamped onto nineteen leads, and every step failed at send.
    const named = steps.filter((s) => s.templateKey);
    if (named.length) {
      const rows = await db
        .collection(C.templates)
        .find({ orgId: ctx.orgId, productId, status: "active" }, { projection: { key: 1, family: 1, channel: 1 } })
        .toArray();
      const onChannel = new Set(rows.flatMap((t) => [String(t.key), String(t.family ?? "")].filter(Boolean).map((k) => `${String(t.channel ?? "email")}:${k}`)));
      const wrong = named.filter((s) => !onChannel.has(`${s.channel}:${s.templateKey}`));
      if (wrong.length) {
        const menu = (channel: string) => [...new Set([...onChannel].filter((k) => k.startsWith(`${channel}:`)).map((k) => k.slice(channel.length + 1)))];
        throw new Error(
          wrong
            .map((s) => `step ${s.id} names "${s.templateKey}", which is no active ${s.channel} template. On ${s.channel} there is: ${menu(s.channel).join(", ") || "nothing"}.`)
            .join(" ") + " Nothing was written.",
        );
      }
    }

    const budget = (goal.budget ?? {}) as { touches?: number };
    if (budget.touches !== undefined && steps.length > budget.touches) {
      throw new Error(
        `this playbook has ${steps.length} steps but the campaign's budget is ${budget.touches} touches. ` +
          `The steps past the budget would never send.`,
      );
    }

    // The engine sends this campaign's first touch the moment a lead lands, without waiting
    // for anybody — so a playbook that opens with the same angle is asking for a second copy
    // of a message already on its way. Seventeen people were holding two or three at once
    // before this was caught, fifteen of them identical.
    const opener = String((goal.firstTouch as { templateKey?: string } | undefined)?.templateKey ?? "").toLowerCase();
    if (opener && String(steps[0]!.angle).toLowerCase() === opener) {
      throw new Error(
        `step 1 uses the angle "${steps[0]!.angle}", which is the first touch this campaign already sends ` +
          `automatically when someone arrives. Start this sequence at the message that comes after it — ` +
          `the opener is handled for you, and repeating it means two identical emails.`,
      );
    }

    // The same guardrail plan_goal applies, checked once here instead of once per person —
    // which is most of why a playbook is cheaper than a thousand plans.
    const block = await explorationBlock(
      ctx.orgId,
      productId,
      segmentKey === "default" ? undefined : segmentKey,
      steps.map((s) => s.angle),
    );
    if (block) throw new Error(block);

    const existing = await db
      .collection(C.playbooks)
      .findOne({ orgId: ctx.orgId, productId, goalKey, segmentKey });
    const version = Number(existing?.version ?? 0) + 1;

    await db.collection(C.playbooks).updateOne(
      { orgId: ctx.orgId, productId, goalKey, segmentKey },
      {
        $set: {
          steps,
          version,
          rationale: str(args.rationale),
          createdBy: "claude",
          updatedAt: new Date(),
        },
        $setOnInsert: { _id: new ObjectId(), orgId: ctx.orgId, productId, goalKey, segmentKey, createdAt: new Date() },
      },
      { upsert: true },
    );

    // Existing runners are not rewritten from here. The engine re-stamps anyone whose
    // sequence is still essentially unspent on its next pass, and leaves alone anyone far
    // enough in that a new sequence would contradict what they have already read.
    const running = await db.collection(C.goalInstances).countDocuments({
      orgId: ctx.orgId,
      productId,
      goalKey,
      status: "active",
    });

    return {
      segment: segmentKey,
      version,
      steps: steps.length,
      running_this_campaign: running,
      note:
        version === 1
          ? "Everybody who arrives in this segment from now on runs this within seconds, with no model in the path."
          : "People early in their sequence move to this version on the next tick; anyone further in keeps the sequence they have already been reading.",
    };
  },
});

/**
 * A new idea, written by the planner when nothing in the bank fits a lead.
 *
 * Dhaval, 2026-09-18: the 88 approved ideas are a start, not a ceiling. Claude may add to them,
 * but an invented idea is a trial: it reaches TRIAL_LEADS leads, every email still waits in
 * Review, and the first sends decide whether it stays. Its capability must be one the product
 * really has, word for word from writing.facts.canDo, so a new idea can never be a new claim.
 * IDEAS_LOOP=off switches it off.
 */
TOOLS.push({
  name: "propose_idea",
  description:
    "Add a new idea to the product's idea bank when no pattern on lead_card writing.ideas fits the lead in front of you (a new shape of an existing pattern needs no new idea: plan it from that idea). The idea is a scene from an Indian office week that TeamGrid makes visible, with its pattern (why it lands) and other shapes it can take, so the next planner learns from it. proof must be copied word for word from one writing.facts.canDo entry: that is what makes it true. It starts as a trial: plan_goal lets it reach 5 leads, then their results move it to active (ranked like the bank) or retire it. Refused: a title another idea already has, a proof that is not in canDo, testimonial or verdict words, and more than 10 trial ideas open at once. Returns the idea's number for plan_goal idea_refs.",
  inputSchema: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      title: { type: "string", description: "The scene in a few words, the way a founder would say it: \"The dispatch that waited for one signature\"." },
      detail: { type: "string", description: "One sentence: who lives this and what it costs or hides." },
      pattern: { type: "string", description: "Why it lands, in one sentence, so the next planner can learn it and find other shapes of it." },
      also: { type: "array", items: { type: "string" }, description: "2 or 3 other shapes the same pattern can take, in other businesses or moments." },
      hook: { type: "string", enum: ["daily_question", "hidden_bill", "office_habit", "just_ask", "found_out_late", "no_watching", "closing"] },
      proof: { type: "string", description: "One writing.facts.canDo text, word for word." },
      card: { type: "string", enum: ["summary", "apps", "day", "none"], description: "The sample card that can show it, or none." },
      segments: { type: "array", items: { type: "string" }, description: "Segments it suits, e.g. founder, hr_ops, agency_owner." },
      keywords: { type: "array", items: { type: "string" }, description: "Words in a lead's answers or website that should bring this idea up." },
      from_refs: { type: "array", items: { type: "number" }, description: "Bank ideas it grew from, if any." },
      reason: { type: "string", description: "Why no bank idea fitted, in one sentence." },
      goal_instance_id: { type: "string", description: "The lead it was written for." },
    },
    required: ["product_id", "title", "detail", "pattern", "hook", "proof", "card", "reason"],
  },
  async handler(args, ctx) {
    if (!ideasLoopOn()) {
      throw new Error("Inventing ideas is switched off here (IDEAS_LOOP=off). Plan from writing.ideas, or blend two of its ideas. Nothing was written.");
    }
    const productId = String(args.product_id);
    const orgId = await assertProduct(productId, ctx);
    const db = await getDb();
    const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId }, { projection: { "config.writing": 1 } });
    const writing = ((product?.config as { writing?: Record<string, unknown> } | undefined)?.writing ?? {}) as { facts?: { canDo?: Array<{ text?: string; plan?: string }> } };

    const title = String(args.title ?? "").trim();
    const detail = String(args.detail ?? "").trim();
    const reason = String(args.reason ?? "").trim();
    const pattern = String(args.pattern ?? "").trim();
    const also = (Array.isArray(args.also) ? args.also : []).map((v) => String(v).trim()).filter(Boolean).slice(0, 4);
    const hook = String(args.hook ?? "").trim();
    const card = String(args.card ?? "none").trim() as "summary" | "apps" | "day" | "none";
    if (title.length < 8 || title.length > 90) throw new Error(`title is ${title.length} characters; write the scene in 8 to 90. Nothing was written.`);
    if (!detail || detail.length > 240) throw new Error("detail is one sentence, under 240 characters. Nothing was written.");
    if (!reason) throw new Error("Say in reason why no bank idea fitted. Nothing was written.");
    if (!pattern || pattern.length > 240) throw new Error("pattern is one sentence under 240 characters: why this lands, so the next planner can learn it. Nothing was written.");
    const hooks = (LEAD_TYPE_PROFILES.hot.sequence ?? []).map((s) => s.hook);
    if (!hooks.includes(hook)) throw new Error(`hook must be one of ${hooks.join(", ")}. Nothing was written.`);
    if (!["summary", "apps", "day", "none"].includes(card)) throw new Error("card must be summary, apps, day or none. Nothing was written.");

    const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9₹]+/g, " ").trim();
    const fact = (writing.facts?.canDo ?? []).find((f) => norm(String(f.text ?? "")) === norm(String(args.proof ?? "")));
    if (!fact) {
      throw new Error("proof must be one writing.facts.canDo text, copied word for word, so the idea claims only what the product does. Nothing was written.");
    }
    const said = [title, detail, pattern, ...also].join("\n");
    const loud = [...unprovenClaims(said), ...screenWords(said)];
    if (loud.length) throw new Error(`"${loud[0]}" cannot go in an idea: no customer results, verdict words or screen words. Nothing was written.`);

    const bank = ideasOf(product);
    const invented = inventedOf(product);
    const same = [...bank, ...invented].find((i) => norm(i.title) === norm(title));
    if (same) throw new Error(`#${same.n} already has this title. Plan with it, or write a different scene. Nothing was written.`);
    const open = invented.filter((i) => i.status === "trial").length;
    if (open >= TRIAL_OPEN_MAX) {
      throw new Error(`${open} invented ideas are still on trial. Use the bank or one of those until their results are in. Nothing was written.`);
    }
    const known = new Set([...bank, ...invented].map((i) => i.n));
    const fromRefs = (Array.isArray(args.from_refs) ? args.from_refs : []).map(Number).filter((n) => known.has(n));

    let bornFor: InventedIdea["bornFor"];
    if (args.goal_instance_id && ObjectId.isValid(String(args.goal_instance_id))) {
      const inst = await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(args.goal_instance_id)), orgId }, { projection: { goalKey: 1 } });
      if (inst) bornFor = { goalInstanceId: String(inst._id), goalKey: String(inst.goalKey) };
    }

    const list = (value: unknown) => (Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()).filter(Boolean).slice(0, 12) : []);
    // Two planners can propose at the same moment; the number is taken only if it is still free.
    let n = nextInventedN(invented);
    for (let attempt = 0; attempt < 5; attempt++, n++) {
      const idea: InventedIdea = {
        n,
        title,
        detail,
        pattern,
        ...(also.length ? { also } : {}),
        hook,
        proof: String(fact.text),
        plan: fact.plan ?? "Standard",
        card,
        segments: list(args.segments),
        keywords: list(args.keywords),
        usable: true,
        source: "claude",
        status: "trial",
        reason,
        ...(fromRefs.length ? { fromRefs } : {}),
        ...(bornFor ? { bornFor } : {}),
        createdAt: new Date(),
      };
      const res = await db
        .collection(C.products)
        .updateOne({ _id: new ObjectId(productId), orgId, "config.writing.invented.n": { $ne: n } }, { $push: { "config.writing.invented": idea } } as never);
      if (res.modifiedCount === 1) {
        return {
          n,
          status: "trial",
          plan: idea.plan,
          note: `Plan with idea_refs [${n}]. It reaches at most ${TRIAL_LEADS} leads; once those are sent, what_works moves it to active or retires it, with the reason.`,
        };
      }
    }
    throw new Error("Could not find a free idea number after 5 tries. Try again. Nothing was written.");
  },
});

// LinkedIn (routine 6) lives in its own module so the email tools above stay as they are.
TOOLS.push(...LINKEDIN_TOOLS);
