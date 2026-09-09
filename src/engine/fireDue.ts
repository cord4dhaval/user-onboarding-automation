import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import {
  renderTemplate,
  resolveBlocks,
  toOutbound,
  type ComposedContent,
  type MergeVars,
  type RenderableAsset,
} from "./compose.js";
import { renderHtml } from "./html.js";
import { loadBrandKit, type ResolvedKit } from "./brand.js";
import { validate } from "./validate.js";
import { isSuppressed } from "./suppression.js";
import { assetsNeedApproval, creditAssets, highestTier, renderableAssets } from "./assets.js";
import { RetryableSendError, type ChannelAdapter } from "../adapters/channel/types.js";
import { ConsoleAdapter } from "../adapters/channel/console.js";
import { limitsFor, rateBlock, rateHeadroom } from "./governor.js";
import { resolveTemplateFor } from "./templates.js";
import { applyTracking, trackingAllowed } from "./tracking.js";
import { bumpPrior } from "./outcomes.js";
import { localHour } from "./time.js";
import { appOrigin, mergeVarsFor } from "./vars.js";

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

/**
 * How many provider calls are allowed in the air at once.
 *
 * Eight because the ceiling is the cron budget, not the network: twenty-five sequential
 * sends at roughly half a second each is most of a sixty-second request, and the same
 * twenty-five in waves of eight is a few seconds. Higher buys little and makes a provider
 * more likely to answer with a rate limit, which costs a retry rather than saving a wait.
 */
const SEND_CONCURRENCY = 8;

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

  // Sends are network-bound, so they overlap; everything around them stays in order.
  // Claiming, guards and rendering are local database work measured in single-digit
  // milliseconds — running those concurrently would buy nothing and cost the sequencing
  // that makes a double send impossible.
  const inFlight: Array<Promise<void>> = [];
  const flush = async (all: boolean) => {
    if (inFlight.length >= (all ? 1 : SEND_CONCURRENCY)) {
      await Promise.all(inFlight.splice(0, inFlight.length));
    }
  };

  // Rate headroom is read once per channel and then spent down in memory. Re-reading it
  // per action would count only what has landed, which during a batch is not what has been
  // committed to.
  const headroom = new Map<string, number>();
  const reserve = async (channelId: string): Promise<boolean> => {
    if (!headroom.has(channelId)) {
      headroom.set(
        channelId,
        await rateHeadroom(opts.orgId, channelId, await limitsFor(opts.orgId, channelId), now),
      );
    }
    const left = headroom.get(channelId) ?? 0;
    if (left <= 0) return false;
    headroom.set(channelId, left - 1);
    return true;
  };

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
            // What this person has actually been sent, not what the counter believes. The
            // two disagree whenever a touch failed or was re-sent, and the disagreement
            // was reaching real people as the welcome mail arriving twice.
            usedKeys: await rungsSentTo(String(person._id)),
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
      const personId = String(person._id);

      // Shared with the review screen, so what a reviewer reads is rendered from the same
      // variables the recipient's copy is.
      const vars: MergeVars = mergeVarsFor(person, product);

      // What this message carries, resolved at send rather than at compose: an asset that
      // was archived or corrected in the days a message sat in the queue should go out as
      // it is now, not as it was when somebody chose it.
      const carried = await renderableAssets(opts.orgId, opts.productId, action.assetIds);
      const prior = action.content as Partial<ComposedContent> | undefined;
      // Kept beside `prior` rather than folded into it: `prior` is written back to the
      // action when a message is held, and storing a copy of every asset on every action
      // would be a second, staler copy of the thing we just went and read.
      const toRender = { ...prior, assets: carried };
      // An answer to something a person wrote is not a campaign touch, and rendering it
      // through the ladder dresses it as one: it inherits the next rung's heading and
      // subject, so a reply to "what does it cost?" arrives titled "one step left" above a
      // greeting the sender did not write. The words are the whole message here.
      const isReply = String(action.angle) === "reply";
      const content = isReply
        ? replyContent(prior, await replySubject(opts.orgId, opts.productId, personId))
        : prior?.bodyMd && action.reviewedAt
          ? // A message someone read and approved ships exactly as read. Re-rendering it
            // here would let the words change between the review screen and the recipient.
            (prior as ComposedContent)
          : renderTemplate(template.blocks as Record<string, unknown>[], vars, toRender);

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
      const wantsHtml = !isReply && String(action.format ?? template.format ?? "html") !== "text";
      if (!content.bodyHtml && wantsHtml && String(action.channel) === "email" && caps?.html !== false) {
        content.bodyHtml = renderHtml(
          resolveBlocks(template.blocks as Record<string, unknown>[], vars, toRender),
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
          origin: appOrigin(),
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
        isReply,
      });

      if (!check.ok) {
        await release(action._id, "failed", { validation: check });
        summary.failed.push({ person: name || label, error: check.hardFails.join("; ") });
        continue;
      }

      const approvalMode = (goal?.schedule as { approvalMode?: string } | undefined)?.approvalMode ?? "gate_on";
      // An asset can demand review on its own, and that demand outranks the campaign's
      // mode. Auto-send is a decision about routine copy; "hold anything carrying this" is
      // a decision about one particular thing, usually a way to reach a human.
      const gated =
        approvalMode === "gate_on" ||
        (await assetsNeedApproval(opts.orgId, opts.productId, action.assetIds));
      // The gate is for content nobody has looked at. Re-holding a message a human already
      // approved would loop it back to review forever, and nothing would ever send.
      if (gated && !action.reviewedAt && !dryRun) {
        await db.collection(C.actions).updateOne(
          { _id: action._id },
          { $set: { status: "awaiting_approval", content, validation: check } },
        );
        summary.heldForApproval++;
        continue;
      }

      // A slot in the channel's rate window, taken before the send rather than after.
      // blockedReason asked whether the window was full, which is the right question when
      // messages leave one at a time and the wrong one when several are in flight: they all
      // read the same count and all pass. Reserving makes the cap hold at any fan-out.
      if (!dryRun && !(await reserve(String(action.channelId)))) {
        await db.collection(C.actions).updateOne(
          { _id: action._id },
          {
            $set: { status: "queued", dueAt: new Date(now.getTime() + 60_000), deferReason: "channel window full" },
            $unset: { claimedAt: "" },
          },
        );
        summary.deferred++;
        continue;
      }

      const adapter = opts.adapterFor
        ? await opts.adapterFor(String(action.channelId), String(action.channel))
        : new ConsoleAdapter();

      const outbound = toOutbound(content, email, channel.from as string | undefined);
      outbound.replyTo = channel.replyTo as string | undefined;

      // The same address the body's opt-out link points at, promoted to a header so Gmail
      // and Yahoo can offer their own unsubscribe control beside the sender's name. Where
      // they cannot, the reader's remaining option is the spam button — and a complaint is
      // the number that suspends a sending account, where an unsubscribe costs one lead.
      //
      // Never on a rehearsal or a reply. A dry run must not advertise a live one-click URL,
      // and an answer to something a person wrote is one side of a conversation rather than
      // bulk mail: an unsubscribe control under it reads as a form letter.
      if (!dryRun && !isReply) outbound.listUnsubscribeUrl = vars.opt_out_url;

      // Continue the conversation this person is already in, rather than starting a third
      // one beside it. A follow-up that arrives as a fresh message reads as nobody having
      // seen what they wrote, which is the opposite of what a reply-driven sequence is for.
      const conversation = await conversationFor(
        opts.orgId,
        opts.productId,
        String(action.personId),
        String(action.channelId),
        adapter,
      );
      if (conversation) {
        outbound.threadId = conversation.threadId;
        outbound.inReplyTo = conversation.inReplyTo;
        outbound.references = conversation.references;
      }

      // From here on it is one provider call and the writes that record it. Wrapped so it
      // can overlap with its neighbours: the work above decided this message may go, and
      // nothing below it reads state another in-flight send is changing.
      const dispatch = async () => {
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
            // A deferred message also hands its rate slot back: it never reached the
            // provider, so nothing was spent and the next action in this batch may have it.
            headroom.set(String(action.channelId), (headroom.get(String(action.channelId)) ?? 0) + 1);
            return;
          }
          throw err;
        }

        // A queued message is not a sent message. It waits at "dispatched" until the
        // reconciler confirms it with the provider.
        const variant = variantOf(person, action, carried);
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
              // The provider's own handle, which costs nothing — it comes back with the
              // send. The RFC Message-ID is not stored here: it is not in this response, and
              // asking for it now would spend a round trip on every message to serve the few
              // that get a follow-up. conversationFor fetches it if and when one does.
              ...(result.threadId || result.messageId
                ? {
                    thread: {
                      ...(result.threadId ? { id: result.threadId } : {}),
                      // Present when the provider's response settles it. Gmail's is absent
                      // here and filled in later by resolveMessageId; SES's is known now,
                      // so a conversation on SES never spends a round trip discovering it.
                      ...(result.messageId ? { messageId: result.messageId } : {}),
                      references: [...(outbound.references ?? []), result.messageId].filter(Boolean),
                    },
                  }
                : {}),
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
        // Counted here rather than at compose, because a message can be composed, held,
        // and never sent. What an asset earned has to be measured against what it actually
        // went out on.
        if (!dryRun) await creditAssets(opts.orgId, opts.productId, action.assetIds, "sent");
        if (queued) summary.queuedRemotely++;
        else summary.sent++;
      };

      inFlight.push(
        dispatch().catch(async (err) => {
          await release(action._id, "failed", { error: err instanceof Error ? err.message : String(err) });
          summary.failed.push({ person: label, error: err instanceof Error ? err.message : String(err) });
        }),
      );
      await flush(false);
    } catch (err) {
      await release(action._id, "failed", { error: err instanceof Error ? err.message : String(err) });
      summary.failed.push({ person: label, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await flush(true);
  return summary;

  function productIdOf(action: Record<string, unknown>): string {
    return String(action.productId);
  }

  /** The dimensions this send will be judged on, frozen at the moment it goes out. */
  function variantOf(
    person: Record<string, unknown>,
    action: Record<string, unknown>,
    carried: RenderableAsset[] = [],
  ) {
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

    // What rode along, frozen for the same reason everything else here is: an asset can be
    // renamed, retiered or deleted, and a rollup that read it as it stands today would
    // rewrite what every past send meant.
    //
    // `assetKey` is deliberately a single value and null when a message carried nothing or
    // carried several. It is the field a rollup groups on, and grouping on an array would
    // make "the demo" and "the demo plus a case study" the same bucket while looking like
    // it had answered the question. The full list stays beside it for reading one message.
    const keys = carried.map((asset) => asset.key).filter(Boolean);
    variant.assetKeys = keys;
    variant.assetKey = keys.length === 1 ? keys[0] : null;
    variant.assetTier = carried.length > 0 ? highestTier(carried.map((asset) => asset.tier)) : null;
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

/**
 * Which ladder rungs this person has already received.
 *
 * Read from what went out rather than from the touch counter: the counter is incremented
 * on send, so a message that failed, or one sent while the counter was behind, leaves the
 * next render pointing at a rung the reader has already had.
 */
async function rungsSentTo(personId: string): Promise<string[]> {
  const db = await getDb();
  const sent = await db
    .collection(C.actions)
    .find({ personId, status: { $in: ["sent", "dispatched", "sending"] }, templateId: { $exists: true } })
    .project({ templateId: 1 })
    .toArray();
  if (sent.length === 0) return [];

  const ids = [...new Set(sent.map((a) => String(a.templateId)))].map((id) => new ObjectId(id));
  const templates = await db.collection(C.templates).find({ _id: { $in: ids } }).project({ key: 1 }).toArray();
  return templates.map((t) => String(t.key));
}

interface Conversation {
  threadId?: string;
  inReplyTo?: string;
  references: string[];
}

/**
 * The conversation a message to this person should join, if there is one.
 *
 * Two things can be the newest message in it: something we sent, or something they wrote
 * back. Whichever is later is what `In-Reply-To` names — pointing at our own last send when
 * they have since replied threads the message under the wrong parent, and clients that
 * build the tree from headers show the answer above the question.
 *
 * Returns undefined for a first touch, which is a new conversation by definition.
 *
 * Scoped to one channel document rather than to the channel kind. Thread handles belong to
 * the mailbox that minted them, so a person whose sender was switched off and who was moved
 * to another mailbox must start a new conversation there — asked by kind, this found the old
 * mailbox's thread and handed it to an account that has never seen it, which the provider
 * answers with a 404 and the send is lost.
 */
async function conversationFor(
  orgId: string,
  productId: string,
  personId: string,
  channelId: string,
  adapter: ChannelAdapter,
): Promise<Conversation | undefined> {
  const db = await getDb();

  const lastSent = await db
    .collection(C.actions)
    // Either half is enough to continue a conversation, and no provider gives both. Gmail
    // hands back a threadId and hides the Message-ID until asked; SES has no threads at all
    // and threading there is only ever the RFC headers. Requiring thread.id — which is what
    // this asked for when Gmail was the only sender — matches nothing on SES, so every
    // follow-up would start its own conversation.
    .find({
      orgId,
      productId,
      personId,
      channelId,
      status: { $in: ["sent", "dispatched"] },
      $or: [{ "thread.id": { $exists: true } }, { "thread.messageId": { $exists: true } }, { providerMessageId: { $exists: true } }],
    })
    .sort({ sentAt: -1 })
    .limit(1)
    .next();
  if (!lastSent) return undefined;

  const thread = lastSent.thread as { id?: string; messageId?: string; references?: string[] };

  // The parent's RFC Message-ID, fetched the first time anything needs to point at it and
  // written back so no later touch in this conversation asks again. A provider that cannot
  // answer — no read scope, message deleted — leaves threading to threadId alone.
  let parentMessageId = thread.messageId;
  if (!parentMessageId && lastSent.providerMessageId && adapter.resolveMessageId) {
    parentMessageId = await adapter.resolveMessageId(String(lastSent.providerMessageId));
    if (parentMessageId) {
      await db.collection(C.actions).updateOne(
        { _id: lastSent._id },
        {
          $set: {
            "thread.messageId": parentMessageId,
            "thread.references": [...(thread.references ?? []), parentMessageId],
          },
        },
      );
    }
  }

  const references = [...(thread.references ?? []), parentMessageId].filter(Boolean) as string[];
  const conversation: Conversation = {
    threadId: thread.id,
    inReplyTo: parentMessageId,
    references: [...new Set(references)],
  };

  // Their reply, if it came after our last send and carried an id we can point at. A reply
  // read before this change has no rfcMessageId, so the chain quietly falls back to our own
  // last message rather than breaking.
  const reply = await db
    .collection(C.events)
    .find({
      orgId,
      productId,
      personId,
      type: "reply_received",
      ts: { $gt: lastSent.sentAt as Date },
      "payload.rfcMessageId": { $exists: true, $ne: null },
    })
    .sort({ ts: -1 })
    .limit(1)
    .next();
  if (reply) {
    const theirId = String((reply.payload as { rfcMessageId?: unknown }).rfcMessageId);
    conversation.inReplyTo = theirId;
    conversation.references = [...references, theirId];
    const theirThread = (reply.payload as { threadId?: unknown }).threadId;
    if (theirThread) conversation.threadId = String(theirThread);
  }

  return conversation;
}

/**
 * A reply, exactly as it was written.
 *
 * No template, no greeting, no call-to-action button and no unsubscribe block: this is one
 * side of a conversation the other person started, and every one of those turns it back
 * into a campaign message. The opt-out still works — they can say so in a sentence, which
 * the inbound poller reads and honours within the minute.
 */
function replyContent(prior: Partial<ComposedContent> | undefined, subject: string): ComposedContent {
  const body = String(prior?.slotText ?? prior?.bodyMd ?? "").trim();
  return {
    ...(prior as ComposedContent),
    subject: prior?.subject ?? subject,
    bodyMd: body,
    bodyHtml: undefined,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * The subject a reply should carry: theirs, prefixed once.
 *
 * Taken from what they wrote rather than from what we sent, because a person who changed
 * the subject line is telling us what the conversation is now about. Falls back to our own
 * last send, and prefixes nothing that is already a reply — "Re: Re: Re:" is a machine
 * announcing itself.
 */
async function replySubject(orgId: string, productId: string, personId: string): Promise<string> {
  const db = await getDb();
  const inbound = await db
    .collection(C.events)
    .find({ orgId, productId, personId, type: "reply_received" })
    .sort({ ts: -1 })
    .limit(1)
    .next();

  let subject = String((inbound?.payload as { subject?: unknown } | undefined)?.subject ?? "").trim();
  if (!subject) {
    const lastSend = await db
      .collection(C.actions)
      .find({ orgId, productId, personId, status: { $in: ["sent", "dispatched"] } })
      .sort({ sentAt: -1 })
      .limit(1)
      .next();
    subject = String((lastSend?.content as { subject?: unknown } | undefined)?.subject ?? "").trim();
  }
  if (!subject) return "Re: your message";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
