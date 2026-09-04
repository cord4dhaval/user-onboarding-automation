import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { renderTemplate, resolveBlocks, toOutbound, type ComposedContent, type MergeVars } from "./compose.js";
import { renderHtml } from "./html.js";
import { loadBrandKit, type ResolvedKit } from "./brand.js";
import { validate } from "./validate.js";
import { isSuppressed } from "./suppression.js";
import { RetryableSendError, type ChannelAdapter } from "../adapters/channel/types.js";
import { ConsoleAdapter } from "../adapters/channel/console.js";
import { limitsFor, rateBlock } from "./governor.js";
import { resolveTemplateFor } from "./templates.js";
import { applyTracking, trackingAllowed } from "./tracking.js";
import { unsubscribeUrl } from "./unsubscribe.js";
import { bumpPrior } from "./outcomes.js";
import { localHour } from "./time.js";
import { greetingName } from "./names.js";

export interface FireSummary {
  claimed: number;
  sent: number;
  queuedRemotely: number;
  deferred: number;
  heldForApproval: number;
  blocked: Array<{ person: string; reason: string }>;
  failed: Array<{ person: string; error: string }>;
}

/**
 * How long a claim may sit before a later run treats the claiming process as dead. Long
 * enough that no live send is ever interrupted — the slowest provider call here is seconds
 * — and short enough that a crash costs minutes rather than the message.
 */
const STALE_CLAIM_MS = 15 * 60_000;

export interface FireOptions {
  orgId: string;
  productId: string;
  /** Default true. Nothing reaches a provider unless this is explicitly turned off. */
  dryRun?: boolean;
  /** Resolves the adapter for a channel. Falls back to the dry-run console sink. */
  adapterFor?: (channelId: string, channelKey: string) => Promise<ChannelAdapter>;
  now?: Date;
  limit?: number;
}

/**
 * Releases due touches under every guardrail: suppression, goal budget, deadline, and the
 * channel's daily cap. All of it is enforced here in code rather than in a plan or a
 * prompt, so no amount of reasoning upstream can spend past a limit.
 */
export async function fireDue(opts: FireOptions): Promise<FireSummary> {
  const db = await getDb();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? true;
  const summary: FireSummary = {
    claimed: 0,
    sent: 0,
    queuedRemotely: 0,
    deferred: 0,
    heldForApproval: 0,
    blocked: [],
    failed: [],
  };

  // One kit per run rather than one per message: it is the same document for every action
  // in this product, and the send path must not turn into a query per recipient.
  let kitMemo: ResolvedKit | undefined;
  const brandKit = async () => (kitMemo ??= await loadBrandKit(opts.orgId, opts.productId));

  const due = await db
    .collection(C.actions)
    .find({
      orgId: opts.orgId,
      productId: opts.productId,
      $or: [
        { status: "queued", dueAt: { $lte: now } },
        // A claim is a lease, and a process killed mid-send never released it. Without
        // this the action is invisible to every later run — no status it can reach, and no
        // query that finds it — so it simply never sends. Only claims with no provider id
        // are reclaimed: one that got as far as the provider may already be delivered, and
        // sending it twice is worse than leaving it for a human to look at.
        {
          status: "sending",
          claimedAt: { $lte: new Date(now.getTime() - STALE_CLAIM_MS) },
          providerMessageId: { $exists: false },
        },
      ],
    })
    .limit(opts.limit ?? 100)
    .toArray();

  for (const action of due) {
    // Claim it. The status transition is the lease: a second concurrent run finds nothing
    // to update and moves on, so the same touch cannot be sent twice. A reclaim matches on
    // the stale claim time as well, so a run that got there first keeps it.
    const lease =
      action.status === "sending"
        ? { _id: action._id, status: "sending", claimedAt: action.claimedAt }
        : { _id: action._id, status: "queued" };
    const claim = await db.collection(C.actions).findOneAndUpdate(lease, {
      $set: { status: "sending", claimedAt: now },
    });
    if (!claim) continue;
    summary.claimed++;

    const label = String(action.personId);
    try {
      const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
      const goalInstance = await db
        .collection(C.goalInstances)
        .findOne({ _id: new ObjectId(String(action.goalInstanceId)) });
      const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(String(action.channelId)) });

      if (!person || !goalInstance || !channel) {
        await release(action._id, "failed", { error: "missing person, goal or channel" });
        summary.failed.push({ person: label, error: "missing related document" });
        continue;
      }

      // Only the first touch is queued carrying a template id. Every later one is written
      // by a session that supplies the slot copy and cannot know which skeleton it will
      // land in, so the skeleton is chosen here, from how far through the sequence this
      // person actually is. Treating a missing id as a failure instead cost this product
      // 71 messages and would have cost it the 92 still queued behind them.
      const template = action.templateId
        ? await db.collection(C.templates).findOne({ _id: new ObjectId(String(action.templateId)) })
        : await resolveTemplateFor({
            orgId: opts.orgId,
            productId: opts.productId,
            channel: String(action.channel),
            segment: (person.belief as { segment?: string } | undefined)?.segment,
            touchesSpent: Number((goalInstance.spent as { touches?: number } | undefined)?.touches ?? 0),
          });

      if (!template) {
        await release(action._id, "failed", {
          error: `no active ${String(action.channel)} template for this product`,
        });
        summary.failed.push({ person: label, error: "no template on this channel" });
        continue;
      }

      const name = String(person.name ?? "");
      const email = String(person.primaryEmail ?? "");

      const block = await blockedReason({
        orgId: opts.orgId,
        email,
        goalInstance,
        channel,
        now,
      });
      if (block) {
        if (block.retryAt) {
          // Back to the queue at the moment the window frees, exactly like provider
          // back-pressure below. The message keeps its approval and its frozen content, so
          // it goes out later as the words a human already read.
          await db.collection(C.actions).updateOne(
            { _id: action._id },
            {
              $set: { status: "queued", dueAt: block.retryAt, deferReason: block.reason },
              $unset: { claimedAt: "" },
            },
          );
          summary.deferred++;
          continue;
        }
        await release(action._id, "skipped", { skipReason: block.reason });
        summary.blocked.push({ person: name || label, reason: block.reason });
        continue;
      }

      const goal = await db
        .collection(C.goals)
        .findOne({ orgId: opts.orgId, productId: opts.productId, key: String(goalInstance.goalKey) });

      // The trial link comes from the product's own config rather than a hardcoded host,
      // so a second product does not silently send people to the first one's site.
      const product = await db.collection(C.products).findOne({ _id: new ObjectId(productIdOf(action)) });
      const config = (product?.config ?? {}) as { trialLinkTemplate?: string; website?: string };
      const personId = String(person._id);
      const site = (config.website ?? "https://example.com").replace(/\/$/, "");

      const origin = process.env.APP_URL?.replace(/\/$/, "") ?? "";
      const vars: MergeVars = {
        first_name: greetingName(name),
        full_name: name,
        company: String(person.companyDomain ?? "").split(".")[0] || "your team",
        person_id: personId,
        trial_link: (config.trialLinkTemplate ?? `${site}/start?p={{person_id}}`).replace("{{person_id}}", personId),
        // Points at this app, not the product's website. The marketing site has no access
        // to this database, so a link there is a door painted on a wall: the reader
        // believes they have left and the mail keeps coming. Falls back to the old form
        // only when APP_URL is unset, where nothing here could work anyway.
        opt_out_url: origin
          ? unsubscribeUrl(origin, personId)
          : `${site}/unsubscribe?p=${personId}`,
      };

      const prior = action.content as Partial<ComposedContent> | undefined;
      // A message someone read and approved ships exactly as read. Re-rendering it here
      // would let the words change between the review screen and the recipient.
      const content =
        prior?.bodyMd && action.reviewedAt
          ? (prior as ComposedContent)
          : renderTemplate(template.blocks as Record<string, unknown>[], vars, prior);

      const priorClaims = await priorClaimsFor(String(action.goalInstanceId));
      const constraints = template.constraints as { maxWords?: number; noClaims?: string[] } | undefined;
      const caps = channel.capabilities as
        | { maxSubjectLength?: number; maxBodyLength?: number; html?: boolean }
        | undefined;

      // The HTML part is frozen with the text, for the same reason: a brand refreshed
      // between approval and send must not change a message a human already signed off.
      // Three things have to agree before a message goes out designed: the template asks
      // for it, the channel can carry it, and the channel is email.
      // A reviewer who chose plain text outranks the template's own format.
      const wantsHtml = String(action.format ?? template.format ?? "html") !== "text";
      if (!content.bodyHtml && wantsHtml && String(action.channel) === "email" && caps?.html !== false) {
        content.bodyHtml = renderHtml(
          resolveBlocks(template.blocks as Record<string, unknown>[], vars, prior),
          await brandKit(),
        );
      }
      // Tracking is wrapped in at send rather than at compose. What a reviewer approved is
      // the words, and a redirect does not change them — but a draft that never goes out
      // should not carry live tracking links either.
      const trackChoice = trackingAllowed((person.consent as { state?: string } | undefined)?.state);
      let trackingApplied = { opens: false, clicks: false };
      // A rehearsal is never tracked. Nothing can click a message that was printed to a
      // console, so recording it as trackable would enter a guaranteed non-click into
      // every rate the planner reads.
      if (content.bodyHtml && !dryRun) {
        const wrapped = applyTracking(content.bodyHtml, {
          actionId: String(action._id),
          origin,
          choice: trackChoice,
          // An unsubscribe that depends on our signing key still verifying is an
          // unsubscribe that can break. It goes direct.
          neverTrack: [vars.opt_out_url],
        });
        content.bodyHtml = wrapped.html;
        trackingApplied = wrapped.applied;
      }

      const check = validate(content, {
        channelKey: String(action.channel),
        maxWords: constraints?.maxWords,
        noClaims: constraints?.noClaims,
        priorClaims,
        maxSubjectLength: caps?.maxSubjectLength,
        maxBodyLength: caps?.maxBodyLength,
      });

      if (!check.ok) {
        await release(action._id, "failed", { validation: check });
        summary.failed.push({ person: name || label, error: check.hardFails.join("; ") });
        continue;
      }

      const approvalMode = (goal?.schedule as { approvalMode?: string } | undefined)?.approvalMode ?? "gate_on";
      // The gate is for content nobody has looked at. Re-holding a message a human already
      // approved would loop it back to review forever, and nothing would ever send.
      if (approvalMode === "gate_on" && !action.reviewedAt && !dryRun) {
        await db.collection(C.actions).updateOne(
          { _id: action._id },
          { $set: { status: "awaiting_approval", content, validation: check } },
        );
        summary.heldForApproval++;
        continue;
      }

      const adapter = opts.adapterFor
        ? await opts.adapterFor(String(action.channelId), String(action.channel))
        : new ConsoleAdapter();

      const outbound = toOutbound(content, email, channel.from as string | undefined);
      outbound.replyTo = channel.replyTo as string | undefined;

      let result;
      try {
        result = dryRun
          ? await new ConsoleAdapter().send(outbound)
          : await adapter.send(outbound);
      } catch (err) {
        // Back-pressure from a full provider queue: return it to the queue rather than
        // spending a touch on a message nobody received.
        if (err instanceof RetryableSendError) {
          await db.collection(C.actions).updateOne(
            { _id: action._id },
            { $set: { status: "queued", dueAt: new Date(now.getTime() + err.retryAfterSec * 1000), content } },
          );
          summary.deferred++;
          continue;
        }
        throw err;
      }

      // A queued message is not a sent message. It waits at "dispatched" until the
      // reconciler confirms it with the provider.
      const variant = variantOf(person, action);
      const queued = result.disposition === "queued" && !dryRun;
      await db.collection(C.actions).updateOne(
        { _id: action._id },
        {
          $set: {
            status: queued ? "dispatched" : "sent",
            content,
            // Written back for actions that arrived without one. Which skeleton a message
            // rendered through is part of reading it afterwards, and re-deriving it later
            // would give whatever the ladder says today rather than what actually went out.
            templateId: String(template._id),
            sentAt: new Date(),
            providerMessageId: result.providerMessageId,
            dryRun,
            // Copied rather than joined later: segment and fit both move as we learn more,
            // and a rollup keyed on today's values would rewrite what past sends meant.
            variant,
            // Records what this message could report back, so silence from an untracked
            // send is never counted against the angle.
            tracking: trackingApplied,
          },
          // It waited for a window and then went out; the note about waiting is history now.
          $unset: { deferReason: "" },
        },
      );

      // Budget and cap are decremented in the database, never tracked in a caller's head.
      await db.collection(C.goalInstances).updateOne(
        { _id: goalInstance._id },
        {
          $inc: { "spent.touches": 1 },
          // Someone just contacted is the most likely to act, so bring their next check
          // forward rather than waiting out the current interval.
          $set: { lastContactedAt: new Date(), nextVerifyAt: new Date(Date.now() + 60 * 60_000) },
        },
      );
      // The same spend is recorded against the person, so the cost of pursuing one human
      // across every campaign they have ever been in is answerable.
      await db.collection(C.people).updateOne(
        { _id: person._id },
        {
          $inc: { "investment.messages": 1, "investment.usd": Number(action.cost ?? 0) },
          $set: { lastContactedAt: new Date() },
        },
      );
      await db
        .collection(C.channels)
        .updateOne({ _id: channel._id }, { $inc: { "governor.sentToday": 1 } });

      // The shared prior: which step, which hour, which channel. Nothing identifying goes
      // in, so a product that has never sent anything can still start on real mechanics.
      //
      // Never on a dry run. This collection is read by every other tenant, and a rehearsal
      // counted as a send would push a real product towards an hour nobody was mailed at.
      if (!dryRun) await bumpPrior({ channel: action.channel, variant }, "sent");

      if (queued) summary.queuedRemotely++;
      else summary.sent++;
    } catch (err) {
      await release(action._id, "failed", { error: err instanceof Error ? err.message : String(err) });
      summary.failed.push({ person: label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;

  function productIdOf(action: Record<string, unknown>): string {
    return String(action.productId);
  }

  /** The dimensions this send will be judged on, frozen at the moment it goes out. */
  function variantOf(person: Record<string, unknown>, action: Record<string, unknown>) {
    const belief = person.belief as { segment?: string; fitKnown?: boolean } | undefined;
    const variant: Record<string, unknown> = {
      // People sent to before anyone read them are a real bucket, not a missing value.
      segment: belief?.segment ?? "unclassified",
      hourLocal: localHour(new Date(), String(person.timezone ?? "UTC")),
      fitKnown: belief?.fitKnown !== false,
    };
    // A first touch queued by ingest carries no plan step — it precedes any plan. It is
    // still step one, and saying so is what lets the most common message in the system
    // contribute to the shared timing priors instead of being dropped for want of a key.
    variant.stepIndex = typeof action.planStepId === "number" ? action.planStepId : 1;
    return variant;
  }

  async function release(id: ObjectId, status: string, extra: Record<string, unknown>) {
    const db = await getDb();
    await db.collection(C.actions).updateOne({ _id: id }, { $set: { status, ...extra } });
  }
}

/**
 * Why a message may not go out, and whether that is a verdict or a delay.
 *
 * The difference is the whole point. Suppression, a passed deadline and a spent budget are
 * decisions: the message should never be sent, and marking it skipped is correct. A rate
 * limit is a clock — the same message is perfectly sendable half an hour later. Treating
 * the second like the first is what silently destroyed 85 approved messages when a daily
 * cap filled up mid-batch.
 */
interface Blocked {
  reason: string;
  /** Set only for a temporary block: when to try this message again. */
  retryAt?: Date;
}

async function blockedReason(args: {
  orgId: string;
  email: string;
  goalInstance: Record<string, unknown>;
  channel: Record<string, unknown>;
  now: Date;
}): Promise<Blocked | null> {
  if (await isSuppressed(args.orgId, [args.email])) return { reason: "on the suppression list" };

  const gi = args.goalInstance as { status: string; deadline: Date; spent: { touches: number }; goalKey: string };
  if (gi.status !== "active") return { reason: `goal instance is ${gi.status}` };
  if (new Date(gi.deadline) < args.now) return { reason: "goal deadline passed" };

  const db = await getDb();
  const goal = await db.collection(C.goals).findOne({ orgId: args.orgId, key: gi.goalKey });
  const budget = goal?.budget as { touches: number } | undefined;
  if (budget && gi.spent.touches >= budget.touches) return { reason: "touch budget exhausted" };

  // A channel someone paused is a decision; one the engine marked degraded is a fault that
  // may clear. Neither is a clock, so both wait for a human rather than a timer.
  if (args.channel.status !== "healthy") return { reason: `channel is ${String(args.channel.status)}` };

  // Provider limits are enforced here, in code, from what was actually sent.
  const channelId = String(args.channel._id);
  const limits = await limitsFor(args.orgId, channelId);
  const rate = await rateBlock(args.orgId, channelId, limits, args.now);
  if (rate) return { reason: rate.reason, retryAt: rate.retryAt };

  return null;
}

/** Everything already claimed in this goal instance, so a later touch cannot repeat it. */
async function priorClaimsFor(goalInstanceId: string): Promise<string[]> {
  const db = await getDb();
  const sent = await db
    .collection(C.actions)
    .find({ goalInstanceId, status: "sent" })
    .project({ "content.claimsMade": 1 })
    .toArray();
  return sent.flatMap((a) => ((a.content as { claimsMade?: string[] })?.claimsMade ?? []));
}
