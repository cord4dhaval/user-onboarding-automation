import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { renderTemplate, toOutbound, type MergeVars } from "./compose.js";
import { validate } from "./validate.js";
import { isSuppressed } from "./suppression.js";
import { RetryableSendError, type ChannelAdapter } from "../adapters/channel/types.js";
import { ConsoleAdapter } from "../adapters/channel/console.js";
import { limitsFor, rateCheck } from "./governor.js";

export interface FireSummary {
  claimed: number;
  sent: number;
  queuedRemotely: number;
  deferred: number;
  heldForApproval: number;
  blocked: Array<{ person: string; reason: string }>;
  failed: Array<{ person: string; error: string }>;
}

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

  const due = await db
    .collection(C.actions)
    .find({ orgId: opts.orgId, productId: opts.productId, status: "queued", dueAt: { $lte: now } })
    .limit(opts.limit ?? 100)
    .toArray();

  for (const action of due) {
    // Claim it. The status transition is the lease: a second concurrent run finds nothing
    // to update and moves on, so the same touch cannot be sent twice.
    const claim = await db.collection(C.actions).findOneAndUpdate(
      { _id: action._id, status: "queued" },
      { $set: { status: "sending", claimedAt: now } },
    );
    if (!claim) continue;
    summary.claimed++;

    const label = String(action.personId);
    try {
      const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
      const goalInstance = await db
        .collection(C.goalInstances)
        .findOne({ _id: new ObjectId(String(action.goalInstanceId)) });
      const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(String(action.channelId)) });
      const template = action.templateId
        ? await db.collection(C.templates).findOne({ _id: new ObjectId(String(action.templateId)) })
        : null;

      if (!person || !goalInstance || !channel || !template) {
        await release(action._id, "failed", { error: "missing person, goal, channel or template" });
        summary.failed.push({ person: label, error: "missing related document" });
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
        await release(action._id, "skipped", { skipReason: block });
        summary.blocked.push({ person: name || label, reason: block });
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

      const vars: MergeVars = {
        first_name: name.split(" ")[0] || "there",
        full_name: name,
        company: String(person.companyDomain ?? "").split(".")[0] || "your team",
        person_id: personId,
        trial_link: (config.trialLinkTemplate ?? `${site}/start?p={{person_id}}`).replace("{{person_id}}", personId),
        opt_out_url: `${site}/unsubscribe?p=${personId}`,
      };

      const content = renderTemplate(
        template.blocks as Record<string, unknown>[],
        vars,
        action.content && (action.content as { bodyMd?: string }).bodyMd
          ? (action.content as never)
          : undefined,
      );

      const priorClaims = await priorClaimsFor(String(action.goalInstanceId));
      const constraints = template.constraints as { maxWords?: number; noClaims?: string[] } | undefined;
      const caps = channel.capabilities as
        | { maxSubjectLength?: number; maxBodyLength?: number }
        | undefined;
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
      if (approvalMode === "gate_on" && !dryRun) {
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
      const queued = result.disposition === "queued" && !dryRun;
      await db.collection(C.actions).updateOne(
        { _id: action._id },
        {
          $set: {
            status: queued ? "dispatched" : "sent",
            content,
            sentAt: new Date(),
            providerMessageId: result.providerMessageId,
            dryRun,
          },
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

  async function release(id: ObjectId, status: string, extra: Record<string, unknown>) {
    const db = await getDb();
    await db.collection(C.actions).updateOne({ _id: id }, { $set: { status, ...extra } });
  }
}

async function blockedReason(args: {
  orgId: string;
  email: string;
  goalInstance: Record<string, unknown>;
  channel: Record<string, unknown>;
  now: Date;
}): Promise<string | null> {
  if (await isSuppressed(args.orgId, [args.email])) return "on the suppression list";

  const gi = args.goalInstance as { status: string; deadline: Date; spent: { touches: number }; goalKey: string };
  if (gi.status !== "active") return `goal instance is ${gi.status}`;
  if (new Date(gi.deadline) < args.now) return "goal deadline passed";

  const db = await getDb();
  const goal = await db.collection(C.goals).findOne({ orgId: args.orgId, key: gi.goalKey });
  const budget = goal?.budget as { touches: number } | undefined;
  if (budget && gi.spent.touches >= budget.touches) return "touch budget exhausted";

  if (args.channel.status !== "healthy") return `channel is ${String(args.channel.status)}`;

  // Provider limits are enforced here, in code, from what was actually sent.
  const channelId = String(args.channel._id);
  const limits = await limitsFor(args.orgId, channelId);
  const rateBlock = await rateCheck(args.orgId, channelId, limits, args.now);
  if (rateBlock) return rateBlock;

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
