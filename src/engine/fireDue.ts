import { ObjectId, type Document } from "mongodb";
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
import { addressFor, identityValue } from "./address.js";
import { emailHtmlFor } from "./html.js";
import { pictureOf } from "./picture.js";
import { loadBrandKit, type ResolvedKit } from "./brand.js";
import { validate } from "./validate.js";
import { isSuppressed } from "./suppression.js";
import { assetsNeedApproval, assetsForRender, creditAssets, highestTier } from "./assets.js";
import { ChannelDownError, RetryableSendError, type ChannelAdapter } from "../adapters/channel/types.js";
import { ConsoleAdapter } from "../adapters/channel/console.js";
import { limitsFor, nextSpacedSlot, opLimitsFor, rateBlock, rateHeadroom, spacedUntil } from "./governor.js";
import { channelDownHold, takeChannelDown } from "./channelHealth.js";
import { WAITING_FOR_ACCEPT, claudePlansLinkedIn } from "./linkedin.js";
import { bandFor, crossChannelGap, lastOnChannel, type CadenceBand } from "./cadence.js";
import { creditTemplate, resolveTemplateFor } from "./templates.js";
import { applyTextTracking, applyTracking, trackingAllowed } from "./tracking.js";
import { effectiveBand, groupFor, leadTypeOf } from "./rolling.js";
import { bumpPrior } from "./outcomes.js";
import { HOME_TIMEZONE, localHour, nextSendableAt } from "./time.js";
import { appOrigin, mergeVarsFor, withUtm } from "./vars.js";
import { pathAndQuery, providerParams } from "./providerParams.js";

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
const DAY_MS = 86_400_000;


/** The most recent of several timestamps, in whatever shape they were stored. */
function latestOf(values: unknown[]): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) continue;
    if (!best || date > best) best = date;
  }
  return best;
}

function gapLabel(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}-hour`;
  return days === 1 ? "one-day" : `${days}-day`;
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

  // One kit per run rather than one per message: it is the same document for every action
  // in this product, and the send path must not turn into a query per recipient.
  let kitMemo: ResolvedKit | undefined;
  const brandKit = async () => (kitMemo ??= await loadBrandKit(opts.orgId, opts.productId));

  const dueFilter = {
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
  };
  // Approved messages take the run's slots first; unreviewed ones only fill what is left.
  // A first touch nobody has looked at is still "queued", and claiming it only renders it
  // and parks it for review. Picked in no order, 306 of those spent thirteen runs ahead of
  // 22 approved mails on 16 September while nothing went out.
  const limit = opts.limit ?? 100;
  const approved = await db
    .collection(C.actions)
    .find({ ...dueFilter, reviewedAt: { $exists: true } })
    .sort({ dueAt: 1 })
    .limit(limit)
    .toArray();
  const unreviewed =
    approved.length < limit
      ? await db
          .collection(C.actions)
          .find({ ...dueFilter, reviewedAt: { $exists: false } })
          .sort({ dueAt: 1 })
          .limit(limit - approved.length)
          .toArray()
      : [];
  const due = [...approved, ...unreviewed];

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
  const reserve = async (channelId: string, governor: Record<string, unknown> | undefined): Promise<boolean> => {
    if (!headroom.has(channelId)) {
      const room = await rateHeadroom(opts.orgId, channelId, await limitsFor(opts.orgId, channelId), now);
      // A channel that waits a random interval between sends sends one per run: the next
      // slot is only drawn once this send lands, so a second one now would skip the wait.
      headroom.set(channelId, governor?.spacing ? Math.min(room, 1) : room);
    }
    const left = headroom.get(channelId) ?? 0;
    if (left <= 0) return false;
    headroom.set(channelId, left - 1);
    return true;
  };

  // People written to in this run, with the moment they were claimed. Sends overlap, and
  // the person's lastContactedAt lands only after a send returns, so two messages to one
  // person in the same batch would both pass a check that read the database alone. On
  // 9 September two approved steps for one person were claimed in the same second and both
  // went out, five seconds apart, into the same inbox.
  const contactedThisRun = new Map<string, Date>();

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
      // A plan step that names a template (or a family of variants) renders through it. Only
      // a step naming nothing falls back to the ladder rung for how far the person is; that
      // fallback used to serve every composed step, so a "privacy" message written by a
      // session went out inside the "one step left" onboarding frame.
      // An action can name its own template: the engine sets one when a written touch never
      // arrived and a fixed email goes in its place. It outranks the plan step's frame, which
      // would otherwise render an empty slot.
      const rungKey = typeof action.templateKey === "string" && action.templateKey
        ? String(action.templateKey)
        : await stepTemplateKey(goalInstance, action);
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
            ...(rungKey ? { rungKey } : {}),
          });

      if (!template) {
        await release(action._id, "failed", {
          error: `no active ${String(action.channel)} template for this product`,
        });
        summary.failed.push({ person: label, error: "no template on this channel" });
        continue;
      }

      const name = String(person.name ?? "");
      // Whatever addresses this channel: an inbox on email, a phone number on WhatsApp or
      // SMS. Reading primaryEmail unconditionally is what handed a WhatsApp adapter an
      // address it could only reject, one message at a time, with nothing on the row to
      // explain it.
      const address = addressFor(person, String(action.channel));
      if (!address) {
        const kind = String(action.channel) === "email" ? "email address" : "phone number";
        await release(action._id, "skipped", { skipReason: `no ${kind} on this person` });
        summary.blocked.push({ person: name || label, reason: `no ${kind}` });
        continue;
      }

      // LinkedIn is not one kind of send. The first touch to a lead is a connection invite
      // carrying the rendered note; every later touch is a direct message. The engine does
      // not need to poll for acceptance to make this work: a DM sent before the invite is
      // accepted comes back NOT_FIRST_DEGREE, which the adapter turns into a deferral, so the
      // message simply waits in the queue and goes out the moment they accept.
      //
      // "First touch" is read from what has actually been sent, not a flag: the first
      // LinkedIn send to this person is the invite, anything after it is a DM. Decided before
      // the guards, because an invite and a message have different limits and lengths.
      const op =
        String(action.channel) === "linkedin"
          ? (await db.collection(C.actions).countDocuments({
              orgId: opts.orgId,
              productId: opts.productId,
              personId: action.personId,
              channel: "linkedin",
              status: "sent",
              _id: { $ne: action._id },
            })) > 0
            ? ("message" as const)
            : ("invite" as const)
          : undefined;

      const block = await blockedReason({
        orgId: opts.orgId,
        address,
        person,
        template,
        goalInstance,
        channel,
        op,
        isReply: String(action.angle) === "reply",
        now,
      });
      if (block) {
        // A channel a send took down: kept, not skipped, and released on reconnect.
        if (block.hold) {
          await db.collection(C.actions).updateOne(
            { _id: action._id },
            { $set: { status: "held", heldReason: block.reason }, $unset: { claimedAt: "" } },
          );
          summary.deferred++;
          continue;
        }
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

      // One message per person per gap, enforced at the one point nothing can bypass. A
      // plan, a compose call and a reviewer can each put a second message in front of
      // someone before the first has had its gap; every one of them passes through here.
      // An answer to something they wrote is exempt: that is a conversation, not a
      // campaign touch, and holding it for the band would be the worse rudeness.
      if (String(action.angle) !== "reply") {
        // Paced at the campaign's lead type where that is warmer than the person's own reading,
        // the same band the due date was set from; otherwise a hot campaign's next email is
        // held for a warm gap here after being dated for a hot one.
        const paceBand = effectiveBand(
          (person.temp as { band?: string } | undefined)?.band,
          leadTypeOf(goal),
          (person.enrichment as { form?: { timeline?: unknown } } | undefined)?.form?.timeline,
        );
        const band = bandFor(paceBand, goal?.cadenceByTemp as Record<string, CadenceBand> | undefined);
        const channelKey = String(action.channel);
        const last = latestOf([contactedThisRun.get(`${String(person._id)}|${channelKey}`), lastOnChannel(person, channelKey)]);
        // LinkedIn touches Claude planned were dated by the channel's own gaps (a first
        // message 0 to 2 days after the accept), which the campaign's email gap would undo.
        const planPaced = channelKey === "linkedin" && claudePlansLinkedIn(goal);
        const gapEnds =
          !planPaced && last && band.minGapDays < 999 ? new Date(last.getTime() + band.minGapDays * DAY_MS) : null;
        const lastAny = latestOf([contactedThisRun.get(String(person._id)), person.lastContactedAt]);
        const crossGap = crossChannelGap(paceBand);
        const spacingEnds = lastAny ? new Date(lastAny.getTime() + crossGap.ms) : null;
        const earliest = latestOf([gapEnds, spacingEnds]);
        if (earliest && earliest > now) {
          const byGap = gapEnds !== null && earliest.getTime() === gapEnds.getTime();
          await db.collection(C.actions).updateOne(
            { _id: action._id },
            {
              $set: {
                status: "queued",
                dueAt: earliest,
                deferReason: byGap
                  ? `waiting out the ${gapLabel(band.minGapDays)} gap since their last ${channelKey} message`
                  : `keeping ${crossGap.label} after their last message on another channel`,
              },
              $unset: { claimedAt: "" },
            },
          );
          summary.deferred++;
          continue;
        }
        contactedThisRun.set(String(person._id), now);
        contactedThisRun.set(`${String(person._id)}|${channelKey}`, now);
      }

      // The trial link comes from the product's own config rather than a hardcoded host,
      // so a second product does not silently send people to the first one's site.
      const product = await db.collection(C.products).findOne({ _id: new ObjectId(productIdOf(action)) });
      const personId = String(person._id);

      // Shared with the review screen, so what a reviewer reads is rendered from the same
      // variables the recipient's copy is.
      const vars: MergeVars = mergeVarsFor(person, product);
      // Tagged with the campaign and the mail, so the product's own analytics can say what
      // brought a signup. Only the trial link: the booking page and the opt-out are this
      // app's own pages, and tagging them would count our traffic as theirs.
      vars.trial_link = withUtm(
        vars.trial_link,
        String(goalInstance.goalKey ?? "campaign"),
        String(template.key ?? rungKey ?? "mail"),
        String(action.channel),
      );

      // What this message carries, resolved at send rather than at compose: an asset that
      // was archived or corrected in the days a message sat in the queue should go out as
      // it is now, not as it was when somebody chose it.
      const carried = await assetsForRender(opts.orgId, opts.productId, action.assetIds, template.blocks);
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
        | { maxSubjectLength?: number; maxBodyLength?: number; maxNoteLength?: number; html?: boolean; inviteNote?: string }
        | undefined;
      // A LinkedIn invite from an account that cannot add notes goes without one. The words
      // are cleared rather than kept, so the history shows what the lead actually received.
      const blankInvite = op === "invite" && caps?.inviteNote === "none";
      if (blankInvite) content.bodyMd = "";

      // The HTML part is frozen with the text, for the same reason: a brand refreshed
      // between approval and send must not change a message a human already signed off.
      // Three things have to agree before a message goes out designed: the template asks
      // for it, the channel can carry it, and the channel is email.
      // A reviewer who chose plain text outranks the template's own format.
      const wantsHtml = !isReply && String(action.format ?? template.format ?? "html") !== "text";
      if (!content.bodyHtml && wantsHtml && String(action.channel) === "email" && caps?.html !== false) {
        const resolvedForHtml = resolveBlocks(template.blocks as Record<string, unknown>[], vars, toRender);
        content.bodyHtml = emailHtmlFor(
          action.format,
          resolvedForHtml,
          await brandKit(),
          product,
          [action.hook, action.theme, action.angle, template.key],
          pictureOf(action),
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
      // The plain-text part too. A message sent as plain text has no other part, and without
      // this it could never report a click, so plain text would always look like it lost.
      if (!dryRun && !isReply && String(action.channel) === "email" && content.bodyMd) {
        const wrappedText = applyTextTracking(content.bodyMd, {
          actionId: String(action._id),
          origin: appOrigin(),
          choice: trackChoice,
          neverTrack: [vars.opt_out_url, ...(vars.opt_out_short_url ? [vars.opt_out_short_url] : [])],
        });
        content.bodyMd = wrappedText.text;
        if (wrappedText.clicks) trackingApplied = { ...trackingApplied, clicks: true };
      }

      const check = blankInvite ? { ok: true, hardFails: [], softFails: [] } : validate(content, {
        ask: (prior as { ask?: "reply" | "link" } | undefined)?.ask,
        channelKey: String(action.channel),
        maxWords: constraints?.maxWords,
        noClaims: constraints?.noClaims,
        priorClaims,
        maxSubjectLength: caps?.maxSubjectLength,
        // An invite note is held to its own, far shorter limit; a message on the same channel
        // is not. One number for both either rejected every real message or let an invite
        // through that LinkedIn would refuse.
        maxBodyLength: op === "invite" ? (caps?.maxNoteLength ?? caps?.maxBodyLength) : caps?.maxBodyLength,
        isReply,
      });

      if (!check.ok) {
        await release(action._id, "failed", { validation: check });
        summary.failed.push({ person: name || label, error: check.hardFails.join("; ") });
        continue;
      }

      const schedule = goal?.schedule as { approvalMode?: string; firstTouchApproval?: string } | undefined;
      // The campaign's first message can be let through on its own while the rest are read
      // first. Anything but an explicit "auto_send" there defers to the campaign's mode.
      const approvalMode =
        action.firstTouch === true && schedule?.firstTouchApproval === "auto_send"
          ? "auto_send"
          : (schedule?.approvalMode ?? "gate_on");
      // An asset can demand review on its own, and that demand outranks the campaign's
      // mode. Auto-send is a decision about routine copy; "hold anything carrying this" is
      // a decision about one particular thing, usually a way to reach a human.
      //
      // Only an explicit "auto_send" skips review. A missing or unrecognised mode holds, so a
      // bad write can cost a delay but never sends mail nobody agreed to send unread.
      const gated =
        approvalMode !== "auto_send" ||
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
      if (!dryRun && !(await reserve(String(action.channelId), channel.governor as Record<string, unknown> | undefined))) {
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

      // Building the adapter resolves the mailbox's credential, which can refresh its OAuth
      // token. A refresh that fails for a bad minute is the same kind of delay as a throttled
      // provider, so it gets the same treatment as one: back to the queue, slot handed back.
      let adapter: ChannelAdapter;
      try {
        adapter = opts.adapterFor
          ? await opts.adapterFor(String(action.channelId), String(action.channel))
          : new ConsoleAdapter();
      } catch (err) {
        if (!(err instanceof RetryableSendError)) throw err;
        await db.collection(C.actions).updateOne(
          { _id: action._id },
          {
            $set: { status: "queued", dueAt: new Date(now.getTime() + err.retryAfterSec * 1000), deferReason: err.message },
            $unset: { claimedAt: "" },
          },
        );
        summary.deferred++;
        if (!dryRun) headroom.set(String(action.channelId), (headroom.get(String(action.channelId)) ?? 0) + 1);
        continue;
      }

      const outbound = toOutbound(content, address, channel.from as string | undefined);
      outbound.replyTo = channel.replyTo as string | undefined;

      // The values behind the rendered words, carried through to the adapter. A provider
      // that takes prose ignores them; one that takes named parameters has nothing else to
      // work from, because by this point the prose has already absorbed them.
      outbound.vars = {
        ...(vars as unknown as Record<string, string>),
        email: String(person.primaryEmail ?? ""),
        phone: identityValue(person, "phone"),
        // This lead's own trial link after the host, for a template button whose address is
        // fixed up to the host: the signup it leads to is then theirs, as an email's is.
        trial_path: pathAndQuery(vars.trial_link),
        // What the writer put in the template's open places ("message", "question"), by name.
        // Read off the stored action, not the render, which knows nothing about them.
        ...((prior as { templateParams?: Record<string, string> } | undefined)?.templateParams ?? {}),
      };
      outbound.ref = String(action._id);
      const approved = template.providerTemplate as { name: string; params?: Record<string, string> } | undefined;
      // An answer to their reply goes as its own words, inside the reply window, never as
      // whichever approved template the channel holds.
      if (approved?.name && !isReply) {
        const filled = providerParams(approved.params ?? {}, outbound.vars);
        if ("problem" in filled) {
          const reason = `${approved.name}: ${filled.problem}`;
          await release(action._id, "skipped", { skipReason: reason });
          summary.blocked.push({ person: name || label, reason });
          continue;
        }
        outbound.providerTemplate = { name: approved.name, params: filled.params };
      }

      // The slug is in `outbound.to`. The member id behind it is cached on the person once
      // looked up, and only for this slug, so a corrected URL is looked up again.
      if (op) {
        outbound.op = op;
        // Empty for a blank invite: the adapter sends it without a note.
        outbound.note = content.bodyMd;
        const known = person.linkedin as { slug?: string; providerId?: string } | undefined;
        if (known?.slug === address && known.providerId) outbound.providerId = known.providerId;
      }

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
          // A LinkedIn lead is looked up once, here, and the answer kept on the person before
          // the send is tried: a DM that waits days for an invite to be accepted is retried
          // many times, and each retry used to spend another profile view finding the same id.
          if (!dryRun && outbound.op && !outbound.providerId && adapter.resolveRecipient) {
            outbound.providerId = await adapter.resolveRecipient(outbound.to);
            await db.collection(C.people).updateOne(
              { _id: person._id },
              { $set: { linkedin: { slug: outbound.to, providerId: outbound.providerId, checkedAt: new Date() } } },
            );
          }
          result = dryRun
            ? await new ConsoleAdapter().send(outbound)
            : await adapter.send(outbound);
        } catch (err) {
          // Back-pressure from a full provider queue: return it to the queue rather than
          // spending a touch on a message nobody received.
          if (err instanceof RetryableSendError) {
            await db.collection(C.actions).updateOne(
              { _id: action._id },
              {
                $set: {
                  status: "queued",
                  dueAt: new Date(now.getTime() + err.retryAfterSec * 1000),
                  content,
                  deferReason: err.message,
                },
              },
            );
            summary.deferred++;
            // A deferred message also hands its rate slot back: it never reached the
            // provider, so nothing was spent and the next action in this batch may have it.
            headroom.set(String(action.channelId), (headroom.get(String(action.channelId)) ?? 0) + 1);
            // The channel is the problem, not this message: stop it, say why on the row, and
            // hold its queue until someone reconnects it. This message is held by name, since
            // a send still in flight beside it can requeue after the sweep has run.
            if (err instanceof ChannelDownError) {
              await takeChannelDown(opts.orgId, String(action.channelId), err.message, err.sessionEnded);
              await db.collection(C.actions).updateOne(
                { _id: action._id },
                { $set: { status: "held", heldReason: channelDownHold(err.message) } },
              );
              headroom.set(String(action.channelId), 0);
            }
            return;
          }
          throw err;
        }

        // A queued message is not a sent message. It waits at "dispatched" until the
        // reconciler confirms it with the provider.
        const variant = variantOf(
          person,
          action,
          carried,
          content.bodyHtml ? (String(action.format) === "letter" ? "letter" : "html") : "text",
        );
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
              ...(op ? { op } : {}),
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
            $unset: { deferReason: "", dueReason: "" },
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
        // Where the LinkedIn relationship now stands, on the lead: invited, and connected when
        // LinkedIn said they already were. The accept check fills in the rest.
        if (op === "invite" && !dryRun) {
          await db.collection(C.people).updateOne(
            { _id: person._id },
            {
              $set: {
                "linkedin.invitedAt": new Date(),
                ...(result.relationship === "connected" ? { "linkedin.connectedAt": new Date() } : {}),
              },
            },
          );
        }
        // The same spend is recorded against the person, so the cost of pursuing one human
        // across every campaign they have ever been in is answerable.
        await db.collection(C.people).updateOne(
          { _id: person._id },
          {
            $inc: { "investment.messages": 1, "investment.usd": Number(action.cost ?? 0) },
            // Per channel as well, because the campaign's gap is counted per channel.
            $set: { lastContactedAt: new Date(), [`contactedOn.${String(action.channel)}`]: new Date() },
          },
        );
        // A channel that paces at random draws its next slot now, from the moment this one
        // actually went, and nothing else leaves it before then.
        const nextSlot = dryRun ? null : nextSpacedSlot(channel.governor as Record<string, unknown> | undefined);
        await db
          .collection(C.channels)
          .updateOne(
            { _id: channel._id },
            { $inc: { "governor.sentToday": 1 }, ...(nextSlot ? { $set: { "governor.nextSendAt": nextSlot } } : {}) },
          );

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
        // The template's own count, so variants of one first mail can be compared on what
        // actually went out; wins and silence are graded 48 hours later.
        if (!dryRun) await creditTemplate(action.templateId, "sent");
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
    format?: "html" | "text" | "letter",
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

    // The rolling planner's labels, so results can be read by the idea, the way it was
    // delivered, the format and the ask, within a group of similar leads. Frozen like the
    // rest: a lead's team size or segment can be corrected after the message went out.
    variant.theme = typeof action.theme === "string" && action.theme ? action.theme : null;
    variant.hook = typeof action.hook === "string" && action.hook ? action.hook : null;
    if (format) variant.format = format;
    variant.ask = (action.content as { ask?: string } | undefined)?.ask === "reply" ? "reply" : "link";
    variant.group = groupFor(person as Document);
    if (typeof action.layout === "string" && action.layout) variant.layout = action.layout;
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
  /** Neither a verdict nor a clock: keep the message until a person brings the channel back. */
  hold?: boolean;
}

async function blockedReason(args: {
  orgId: string;
  /** Whatever addresses this channel — suppression is keyed on the identity, not on email. */
  address: string;
  person: Record<string, unknown>;
  template: Record<string, unknown>;
  goalInstance: Record<string, unknown>;
  channel: Record<string, unknown>;
  /** The LinkedIn action this send will be, which has limits of its own. */
  op?: string;
  isReply?: boolean;
  now: Date;
}): Promise<Blocked | null> {
  if (await isSuppressed(args.orgId, [args.address])) return { reason: "on the suppression list" };

  const gi = args.goalInstance as { status: string; deadline: Date; spent: { touches: number }; goalKey: string };
  if (gi.status !== "active") return { reason: `goal instance is ${gi.status}` };
  if (new Date(gi.deadline) < args.now) return { reason: "goal deadline passed" };

  const db = await getDb();
  const goal = await db.collection(C.goals).findOne({ orgId: args.orgId, key: gi.goalKey });
  const budget = goal?.budget as { touches: number } | undefined;
  if (budget && gi.spent.touches >= budget.touches) return { reason: "touch budget exhausted" };

  // Where Claude plans a campaign's LinkedIn touches, it first decides whether to invite each
  // lead at all (routine 6). The invite waits for that, and a "no" is a verdict.
  if (args.op === "invite" && claudePlansLinkedIn(goal)) {
    const pick = (args.goalInstance.linkedin as { pick?: string; pickWhy?: string } | undefined) ?? {};
    if (pick.pick === "skip") return { reason: `Claude chose not to invite them: ${pick.pickWhy ?? "no reason given"}` };
    if (pick.pick !== "invite") return { reason: "waiting for Claude to decide whether to invite", retryAt: new Date(args.now.getTime() + 3_600_000) };
  }

  // A channel someone paused is a decision; one the engine marked degraded is a fault that
  // may clear. Neither is a clock, so both wait for a human rather than a timer.
  // Except one a send took down (a LinkedIn session that ended): its queue is held for the
  // reconnect that releases it, and a message reaching it now joins that queue.
  if (args.channel.status !== "healthy" && args.channel.downReason) {
    return { reason: channelDownHold(String(args.channel.downReason)), hold: true };
  }
  if (args.channel.status !== "healthy") return { reason: `channel is ${String(args.channel.status)}` };

  const outsideWindow = windowBlock(args.channel, args.person, args.template, args.now, args.isReply === true);
  if (outsideWindow) return outsideWindow;

  // A channel with its own sending hours (LinkedIn: mornings) sends only inside them, in
  // the lead's timezone. An answer to something they wrote is a conversation and does not
  // wait for the morning.
  const quiet = (args.channel.policy as { quietHours?: [number, number] } | undefined)?.quietHours;
  if (quiet && !args.isReply) {
    const opens = nextSendableAt(args.now, String(args.person.timezone ?? HOME_TIMEZONE), "batch", quiet);
    if (opens > args.now) return { reason: "outside this channel's sending hours in the lead's timezone", retryAt: opens };
  }

  // Provider limits are enforced here, in code, from what was actually sent.
  const channelId = String(args.channel._id);
  const limits = await limitsFor(args.orgId, channelId);
  const rate = await rateBlock(args.orgId, channelId, limits, args.now);
  if (rate) return { reason: rate.reason, retryAt: rate.retryAt };

  // Then the limit for this kind of action, where the channel has one: invites are held to
  // far fewer a day than messages, and a weekly ceiling on top.
  const governor = args.channel.governor as Record<string, unknown> | undefined;
  const perOp = args.op ? opLimitsFor(governor, args.op, args.now) : null;
  if (perOp) {
    const opRate = await rateBlock(args.orgId, channelId, perOp.limits, args.now, perOp.scope);
    if (opRate) return { reason: opRate.reason, retryAt: opRate.retryAt };
  }

  // Invites stop while too few of them are accepted; the accept check lifts it.
  const invitesPaused = (governor as { invitesPausedReason?: string } | undefined)?.invitesPausedReason;
  if (args.op === "invite" && invitesPaused) {
    return { reason: invitesPaused, retryAt: new Date(args.now.getTime() + 24 * 3_600_000) };
  }
  // A LinkedIn message goes to a connection only. Asking LinkedIn to find out costs a call
  // and an error per retry, so the lead's record decides: expired is a verdict, not yet
  // connected is a wait that the accept check ends early.
  if (args.op === "message") {
    const li = args.person.linkedin as { connectedAt?: Date; inviteExpiredAt?: Date } | undefined;
    if (li?.inviteExpiredAt && !li.connectedAt) return { reason: "the LinkedIn invite was not accepted" };
    if (!li?.connectedAt) return { reason: WAITING_FOR_ACCEPT, retryAt: new Date(args.now.getTime() + 6 * 3_600_000) };
  }

  // A clock like the rest: the channel drew a random wait after its last send.
  const spaced = spacedUntil(governor, args.now);
  if (spaced) return { reason: "waiting for the channel's next randomly spaced send slot", retryAt: spaced };

  return null;
}

/**
 * WhatsApp-style reply windows, enforced rather than described.
 *
 * `capabilities.windowRules` has been on the channel since the schema was written and was
 * read by nothing: the planner could see it, the send path could not, so a WhatsApp channel
 * happily handed Meta free-form prose hours after the window shut and collected a rejection
 * per person. Meta's rule is that outside the window only an approved template may go, and
 * the quality rating that gets a number banned is fed by exactly these attempts.
 *
 * Written as "24h" on the channel and parsed here, so a provider with a different window —
 * or a channel with none — needs no code.
 *
 * This is a verdict, not a clock. The window does not reopen on a timer; it reopens when
 * the person writes back, which may be never. Deferring would hold the message forever and
 * report it as pending the whole time.
 */
function windowBlock(
  channel: Record<string, unknown>,
  person: Record<string, unknown>,
  template: Record<string, unknown>,
  now: Date,
  freeText: boolean,
): Blocked | null {
  const rules = (channel.capabilities as { windowRules?: string } | undefined)?.windowRules;
  const hours = Number(/^(\d+)h$/.exec(rules ?? "")?.[1] ?? 0);
  if (!hours) return null;

  // An approved template is accepted whether the window is open or shut, so nothing below
  // can block it. An answer to their reply is never sent as one — it goes as the words — so
  // it has to be inside the window whatever template the channel happens to hold.
  if (!freeText && (template.providerTemplate as { name?: string } | undefined)?.name) return null;

  // The window is this channel's: an email reply does not open WhatsApp's.
  const replied = (person.repliedOn as Record<string, unknown> | undefined)?.[String(channel.key)];
  const lastReply = replied ? new Date(replied as Date) : undefined;
  const open = lastReply !== undefined && now.getTime() - lastReply.getTime() < hours * 3_600_000;
  if (open) return null;

  return {
    reason: lastReply
      ? `the ${hours}h reply window closed and this template has no approved provider template`
      : `outside the ${hours}h reply window — they have never replied, and this template has no approved provider template`,
  };
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
/** The template key the person's plan put on this action's step, if the plan named one. */
export async function stepTemplateKey(goalInstance: Document, action: Document): Promise<string | undefined> {
  const stepId = Number(action.planStepId);
  if (!Number.isFinite(stepId) || !goalInstance.currentPlanId) return undefined;
  const db = await getDb();
  const plan = await db.collection(C.plans).findOne({ _id: new ObjectId(String(goalInstance.currentPlanId)) }, { projection: { steps: 1 } });
  const step = ((plan?.steps ?? []) as Array<Record<string, unknown>>).find((st) => Number(st.id ?? st.step_id) === stepId);
  const key = step?.templateKey ?? step?.template_key;
  return typeof key === "string" && key ? key : undefined;
}

export async function rungsSentTo(personId: string): Promise<string[]> {
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

  // Absent where the provider handed back only its own id: a LinkedIn invite has an
  // invitation urn and no thread, and reading through it made every DM after an invite fail.
  const thread = (lastSent.thread ?? {}) as { id?: string; messageId?: string; references?: string[] };

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
