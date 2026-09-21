import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { dueAtFor, lastOnChannel, type CadenceBand } from "./cadence.js";
import { detectMovement } from "./detect.js";
import { accessAssetFor, assetContextFor } from "./assets.js";
import { mailboxFilter } from "./channels.js";
import { primaryByPerson } from "./instances.js";
import { ACCESS_RUNG, resolveTemplateFor } from "./templates.js";
import { notify } from "./notify.js";
import { campaignBand, paceBand } from "./rolling.js";

/**
 * Temperature: the campaign's lead type, and the two things a person can do that override it.
 *
 * The lead type is the only type (2026-09-21). It used to be one of two: the person also
 * carried a score of their own, from fit, opens and a form, and the warmer of the two paced
 * their mail. A lead showed "warm" on the screen while being paced hot, and nobody could say
 * which one decided anything.
 *
 * What is left on the person is a summary for the screens that show people rather than
 * messages: the warmest lead type among their running campaigns, unless they did one of two
 * things. A click is the strongest thing a non-replier ever gives us, so it makes them hot
 * for a while. Silence past the campaign's limit, after mail that could have reported a
 * click, stops them. Each message is still paced at its own campaign's type (paceBand).
 */

const DAY = 86_400_000;

/** How long a click keeps somebody hot. A click from six weeks ago is history, not heat. */
const CLICK_HOT_DAYS = 21;

export interface TempInputs {
  /** Sends that could have reported a click. Zero means silence proves nothing. */
  trackableSends: number;
  clicks: number;
  lastClickAt?: Date;
  lastContactedAt?: Date;
  /** From the campaign's failure conditions. How long silence has to run before it is an answer. */
  silenceDays: number;
  /** The band each of their running campaigns paces them at, from its lead type. */
  campaigns: Array<{ key: string; band?: string }>;
  now?: Date;
}

export interface TempResult {
  band?: "hot" | "warm" | "cold" | "dead";
  /** What set the band: a recent click, silence, or their campaign's lead type. */
  by: "click" | "silence" | "campaign" | "none";
  /** The campaign whose lead type set the band, when that is what did. */
  campaign?: string;
  lastClickAt?: Date;
  computedAt: Date;
}

const RANK: Record<string, number> = { cold: 0, warm: 1, hot: 2 };

export function readTemp(input: TempInputs): TempResult {
  const now = (input.now ?? new Date()).getTime();
  const computedAt = new Date(now);

  // Silence is only an answer where the question could be heard. An untracked send tells
  // us nothing about the person, and stopping them for it would be blaming them for a
  // missing pixel.
  const silentFor = input.lastContactedAt ? now - new Date(input.lastContactedAt).getTime() : 0;
  if (input.trackableSends > 0 && input.clicks === 0 && silentFor > input.silenceDays * DAY) {
    return { band: "dead", by: "silence", computedAt };
  }

  if (input.lastClickAt && now - new Date(input.lastClickAt).getTime() <= CLICK_HOT_DAYS * DAY) {
    return { band: "hot", by: "click", lastClickAt: new Date(input.lastClickAt), computedAt };
  }

  let best: { key: string; band: string } | undefined;
  for (const c of input.campaigns) {
    if (!c.band) continue;
    if (!best || (RANK[c.band] ?? -1) > (RANK[best.band] ?? -1)) best = { key: c.key, band: c.band };
  }
  if (!best) return { by: "none", computedAt };
  return { band: best.band as TempResult["band"], by: "campaign", campaign: best.key, computedAt };
}

/**
 * What a reading written before the lead type became the only type meant. A "hot" then was
 * only ever a recent click and "dead" only ever silence, so a migration does not read every
 * clicker as someone who has just clicked.
 */
function byOf(temp: { band?: string; by?: string } | undefined): string | undefined {
  if (temp?.by) return temp.by;
  if (temp?.band === "hot") return "click";
  if (temp?.band === "dead") return "silence";
  return temp?.band ? "campaign" : undefined;
}

export interface RecomputeSummary {
  examined: number;
  changed: number;
  bands: Record<string, number>;
  /** Queued messages whose date moved because the person's reading did. */
  rescheduled: number;
  /** People who clicked and were handed to a session to react to. */
  escalated: number;
  /** People who clicked and were offered a way to reach us. */
  accessOffered: number;
}

/**
 * Refreshes temperature for people in flight, oldest reading first.
 *
 * Runs on the tick rather than on each signal because half of it is decay: nothing happens
 * when someone goes quiet, and a clock is the only thing that can notice. `everyone` reads
 * people in no running campaign too, for a one-off rewrite of every stored reading.
 */
export async function recomputeTemps(
  orgId: string,
  productId: string,
  limit = 100,
  now = new Date(),
  opts: { everyone?: boolean } = {},
): Promise<RecomputeSummary> {
  const db = await getDb();
  const summary: RecomputeSummary = {
    examined: 0,
    changed: 0,
    bands: {},
    rescheduled: 0,
    escalated: 0,
    accessOffered: 0,
  };

  const projection = { temp: 1, lastContactedAt: 1, contactedOn: 1, "enrichment.form.timeline": 1 };
  let scope: Document = { orgId, productId };
  if (!opts.everyone) {
    const inFlight = await db
      .collection(C.goalInstances)
      .find({ orgId, productId, status: "active" }, { projection: { personId: 1 } })
      .limit(limit * 4)
      .toArray();
    if (inFlight.length === 0) return summary;
    scope = { _id: { $in: inFlight.map((i) => new ObjectId(String(i.personId))) } };
  }
  const people = await db
    .collection(C.people)
    .find(scope, { projection })
    // Oldest reading first, so a bounded run still works its way round everybody.
    .sort({ "temp.computedAt": 1 })
    .limit(limit)
    .toArray();
  if (people.length === 0) return summary;

  const ids = people.map((p) => String(p._id));
  // Every running campaign of theirs, not only the rows that found them: the reading is the
  // warmest of their campaigns' lead types.
  const instances = await db
    .collection(C.goalInstances)
    .find(
      { orgId, productId, status: "active", personId: { $in: ids } },
      { projection: { personId: 1, goalKey: 1, currentPlanId: 1, lastContactedAt: 1, startedAt: 1 } },
    )
    .toArray();
  const goals = await db.collection(C.goals).find({ orgId, productId }).toArray();
  const goalByKey = new Map(goals.map((g) => [String(g.key), g]));
  const keysByPerson = new Map<string, string[]>();
  for (const i of instances) {
    const personId = String(i.personId);
    keysByPerson.set(personId, [...(keysByPerson.get(personId) ?? []), String(i.goalKey)]);
  }

  const engagement = new Map<string, { trackable: number; clicks: number; lastClickAt?: Date }>();
  const rows = await db
    .collection(C.actions)
    .aggregate([
      {
        $match: {
          orgId,
          productId,
          personId: { $in: ids },
          status: { $in: ["sent", "dispatched"] },
          // A rehearsal cannot be clicked, so it must not make its recipient look silent.
          dryRun: { $ne: true },
        },
      },
      {
        $group: {
          _id: "$personId",
          trackable: { $sum: { $cond: [{ $eq: ["$tracking.clicks", true] }, 1, 0] } },
          clicks: { $sum: { $cond: [{ $ifNull: ["$firstClickedAt", false] }, 1, 0] } },
          lastClickAt: { $max: "$firstClickedAt" },
        },
      },
    ])
    .toArray();
  for (const r of rows) {
    engagement.set(String(r._id), { trackable: r.trackable, clicks: r.clicks, lastClickAt: r.lastClickAt ?? undefined });
  }

  // One campaign per person for silence and for the hand-over, chosen the way every other
  // "which campaign" is: a lead in two of them would otherwise take whichever row came last.
  const primary = primaryByPerson(instances);
  const goalByPerson = new Map<string, string>([...primary].map(([personId, i]) => [personId, String(i.goalKey)]));
  const instanceByPerson = new Map<string, string>([...primary].map(([personId, i]) => [personId, String(i._id)]));

  for (const person of people) {
    const personId = String(person._id);
    const seen = engagement.get(personId) ?? { trackable: 0, clicks: 0 };
    const silenceGoal = goalByKey.get(goalByPerson.get(personId) ?? "");

    const next = readTemp({
      trackableSends: seen.trackable,
      clicks: seen.clicks,
      lastClickAt: seen.lastClickAt,
      lastContactedAt: person.lastContactedAt as Date | undefined,
      silenceDays: Number((silenceGoal?.failure as { silenceDays?: number } | undefined)?.silenceDays ?? 30),
      campaigns: (keysByPerson.get(personId) ?? []).map((key) => ({ key, band: campaignBand(person, goalByKey.get(key)) })),
      now,
    });

    summary.examined++;
    summary.bands[next.band ?? "none"] = (summary.bands[next.band ?? "none"] ?? 0) + 1;

    const current = person.temp as { band?: string; by?: string; campaign?: string } | undefined;
    const before = byOf(current);
    // Unset fields are left out rather than written as null, so a reading with no band has none.
    const stored = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
    if (current?.by && current.band === next.band && current.by === next.by && current.campaign === next.campaign) {
      // The timestamp is written either way, so an unchanged reading still moves to the
      // back of the queue and a bounded run does not re-examine the same people forever.
      await db.collection(C.people).updateOne({ _id: person._id }, { $set: { "temp.computedAt": next.computedAt } });
      continue;
    }

    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { temp: stored } });
    summary.changed++;

    // Only a click arriving or running out, or silence setting in, changes the pace of any
    // message: each message is paced at its own campaign's type otherwise. A click at two
    // o'clock that left the next message four days out would have earned the person nothing.
    const clickOrSilence = (by?: string) => (by === "click" || by === "silence" ? by : undefined);
    if (clickOrSilence(before) !== clickOrSilence(next.by)) {
      summary.rescheduled += await rescheduleFor(orgId, productId, personId, { ...person, temp: stored }, now);
    }

    // A click is the one change worth a session's attention: the strongest signal a
    // non-replier ever gives.
    if (next.by === "click" && before !== "click") {
      await detectMovement(orgId, productId, {
        personId,
        goalInstanceId: instanceByPerson.get(personId),
        campaignKey: goalByPerson.get(personId),
        reason: "clicked a link",
      });
      summary.escalated++;

      // Telling a person about it was all this used to do, and a lead who has just earned a
      // conversation would then wait for whatever the sequence had scheduled next. The
      // offer goes out now, held for review, because the reason to send it is the thing
      // that just happened.
      if (await offerAccess(orgId, productId, personId, instanceByPerson.get(personId))) {
        summary.accessOffered++;
      }
    }
  }

  return summary;
}

/**
 * Moves a person's unsent messages to the pace their new reading deserves.
 *
 * Only messages nobody has approved and nothing has claimed. A message a human read and
 * signed off ships when they expected it to, and one already in the send path is past the
 * point where its date means anything.
 */
async function rescheduleFor(
  orgId: string,
  productId: string,
  personId: string,
  /** With the new reading already on it, so each message is paced from what was just decided. */
  person: Document,
  now: Date,
): Promise<number> {
  const db = await getDb();
  const queued = await db
    .collection(C.actions)
    .find({ orgId, productId, personId, status: "queued", reviewedAt: { $exists: false } })
    .toArray();
  if (queued.length === 0) return 0;

  // Each message at its own campaign's pace and from its own channel's last contact: a lead
  // in an email campaign and a WhatsApp one has two clocks, not one.
  const instanceIds = [...new Set(queued.map((a) => String(a.goalInstanceId ?? "")).filter(Boolean))];
  const instances = await db
    .collection(C.goalInstances)
    .find({ _id: { $in: instanceIds.map((id) => new ObjectId(id)) } })
    .project({ goalKey: 1 })
    .toArray();
  const goalKeyOf = new Map(instances.map((i) => [String(i._id), String(i.goalKey)]));
  const goals = await db
    .collection(C.goals)
    .find({ orgId, productId, key: { $in: [...new Set(goalKeyOf.values())] } })
    .toArray();
  const goalByKey = new Map(goals.map((g) => [String(g.key), g]));

  let moved = 0;
  for (const action of queued) {
    const goal = goalByKey.get(goalKeyOf.get(String(action.goalInstanceId ?? "")) ?? "") ?? null;
    const last = lastOnChannel(person, String(action.channel ?? "email"));
    const wanted = dueAtFor({
      // What remains of the gap the plan asked for, measured from the last contact rather
      // than from when the plan was written.
      offsetDays: gapDaysOf(action, last),
      band: paceBand(person, goal),
      lastContactedAt: last,
      configured: goal?.cadenceByTemp as Record<string, CadenceBand> | undefined,
      now,
    });
    const current = new Date(String(action.dueAt));
    // Only worth a write if it actually moves the message by more than an hour; rewriting
    // a date by four minutes on every tick is churn, not responsiveness.
    if (Math.abs(wanted.getTime() - current.getTime()) < 3_600_000) continue;
    await db.collection(C.actions).updateOne({ _id: action._id }, { $set: { dueAt: wanted } });
    moved++;
  }
  return moved;
}

/** The gap this message was originally asking for, in days. */
function gapDaysOf(action: Document, lastContactedAt?: Date): number {
  const due = new Date(String(action.dueAt)).getTime();
  const from = lastContactedAt ? new Date(lastContactedAt).getTime() : due;
  return Math.max(0, (due - from) / DAY);
}

/** Why a reading is what it is, for the screens that show one. */
export function explainTemp(temp: Document | null | undefined, campaignName?: (key: string) => string): string {
  switch (temp?.by) {
    case "click":
      return "clicked a link in the last three weeks";
    case "silence":
      return "no click or reply for longer than the campaign waits";
    case "campaign":
      return `lead type of ${campaignName ? campaignName(String(temp.campaign)) : String(temp.campaign)}`;
    case "none":
      return "in no running campaign";
    default:
      return "not read yet";
  }
}

/**
 * Queues the message that hands someone a way to reach us, the moment they earn it.
 *
 * Held for review rather than sent, and not because the campaign says so: the asset itself
 * demands it, and `fireDue` honours that over any auto-send setting. A calendar link and a
 * phone number are the two things this system can give away that cannot be taken back, so
 * a person sees who it is going to before it goes.
 *
 * Returns false, quietly, in every case where there is nothing to offer — no active
 * campaign, no access asset on this product, one already spent on this person, or a
 * campaign whose channels cannot carry it. None of those is a fault; most products will
 * never have an access asset at all, and this has to cost nothing when they do not.
 */
async function offerAccess(
  orgId: string,
  productId: string,
  personId: string,
  goalInstanceId: string | undefined,
): Promise<boolean> {
  if (!goalInstanceId) return false;
  const db = await getDb();

  const instance = await db
    .collection(C.goalInstances)
    .findOne({ _id: new ObjectId(goalInstanceId), status: "active" });
  if (!instance) return false;

  const goal = await db
    .collection(C.goals)
    .findOne({ orgId, productId, key: String(instance.goalKey) });

  // Only called for a click that was just read, so it is said rather than read back.
  const context = { ...(await assetContextFor(orgId, productId, personId, goal)), clicked: true };
  const asset = await accessAssetFor(orgId, productId, context);
  if (!asset) return false;

  // The mailbox this campaign already writes to them from, else one it is allowed to use.
  const channel =
    (instance.channelId
      ? await db.collection(C.channels).findOne({
          _id: new ObjectId(String(instance.channelId)),
          key: { $in: (goal?.allowedChannels ?? ["email"]) as string[] },
          enabled: true,
          status: "healthy",
        })
      : null) ??
    (await db.collection(C.channels).findOne({
      orgId,
      productId,
      key: { $in: (goal?.allowedChannels ?? ["email"]) as string[] },
      enabled: true,
      status: "healthy",
      // A campaign held to particular mailboxes is held to them here too.
      ...mailboxFilter(goal?.channelIds),
    }));
  if (!channel) return false;
  if (String(instance.channelId ?? "") !== String(channel._id)) {
    await db
      .collection(C.goalInstances)
      .updateOne({ _id: instance._id }, { $set: { channelId: String(channel._id), channelAssignedAt: new Date() } });
  }

  const template = await resolveTemplateFor({
    orgId,
    productId,
    channel: String(channel.key),
    segment: undefined,
    rungKey: ACCESS_RUNG,
  });
  // No access template on this channel. Falling back to a ladder rung would send a
  // day-four value proof carrying a calendar, which is a different message entirely.
  if (!template) return false;

  try {
    await db.collection(C.actions).insertOne({
      _id: new ObjectId(),
      orgId,
      productId,
      goalInstanceId,
      personId,
      channel: String(channel.key),
      channelId: String(channel._id),
      templateId: String(template._id),
      angle: "access",
      // No composed copy. The rung's own words carry the message and the asset carries the
      // offer, which is what the slot fallback is for — waiting for a session to write
      // something would spend the moment this exists to catch.
      content: {
        bodyMd: "",
        personalizationUsed: [],
        claimsMade: [],
        wordCount: 0,
      },
      assetIds: [asset.asset_id],
      rationale: `Clicked a link; offered ${asset.key}.`,
      next: {},
      // One per campaign, forever. A second calendar after the first went unanswered is the
      // clearest way to turn a warm lead cold, and the unique index refuses it rather than
      // trusting every caller to check.
      idempotencyKey: `${goalInstanceId}:access`,
      status: "queued",
      dueAt: new Date(),
      cost: 0,
    });
  } catch (err) {
    // Already offered. The index doing its job, not a failure.
    if (err instanceof Error && err.message.includes("E11000")) return false;
    throw err;
  }

  await notify({
    orgId,
    productId,
    severity: "action",
    title: "Someone earned a conversation",
    body: `They clicked a link, so a message offering ${asset.key} is waiting in Review.`,
    href: `/products/${productId}/review`,
    // One row per campaign, matching the one message this can ever queue for it.
    dedupeKey: `access_offered:${goalInstanceId}`,
  });

  return true;
}
