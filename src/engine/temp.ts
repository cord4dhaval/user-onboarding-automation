import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { dueAtFor, type CadenceBand } from "./cadence.js";
import { detectMovement } from "./detect.js";
import { accessAssetFor, assetContextFor } from "./assets.js";
import { ACCESS_RUNG, resolveTemplateFor } from "./templates.js";
import { notify } from "./notify.js";

/**
 * Temperature, recomputed from what a person actually did.
 *
 * It used to be written once, by classify, from fit alone — so the cadence chosen on the
 * day someone arrived ran until their budget died, no matter what they did afterwards. The
 * "hot" band was unreachable in practice: nothing could ever raise a score, only guess it.
 *
 * The terms are deliberately few and legible. A click is the strongest thing a
 * non-replier ever gives us and is weighted accordingly; an open is recorded but nearly
 * discounted, because mail clients that prefetch images fire the pixel whether or not a
 * human looked. Silence only counts against someone who was actually contacted on a
 * message that could have reported back — otherwise the system would cool a person for
 * failing to answer a message it never tracked.
 */

const DAY = 86_400_000;

/** Matches classify's original threshold, so a person with no engagement lands where they did before. */
const WARM_SCORE = 28;

export interface TempInputs {
  icpFit: number;
  fitKnown: boolean;
  /** Sends that could have reported a click. Zero means silence proves nothing. */
  trackableSends: number;
  clicks: number;
  opens: number;
  lastClickAt?: Date;
  lastContactedAt?: Date;
  /** From the goal's failure conditions. How long silence has to run before it is an answer. */
  silenceDays: number;
  now?: Date;
}

export interface TempResult {
  score: number;
  band: "hot" | "warm" | "cold" | "dead";
  computedAt: Date;
  termsUsed: string[];
}

/**
 * Recency decay on a click: full weight for a week, half for two more, nothing after. A
 * click from six weeks ago is history, not heat.
 */
function clickWeight(lastClickAt: Date | undefined, now: number): number {
  if (!lastClickAt) return 0;
  const age = now - new Date(lastClickAt).getTime();
  if (age <= 7 * DAY) return 1;
  if (age <= 21 * DAY) return 0.5;
  return 0;
}

export function computeTemp(input: TempInputs): TempResult {
  const now = (input.now ?? new Date()).getTime();
  const termsUsed: string[] = [input.fitKnown ? "fit" : "fit_unknown"];

  let score = Math.round(input.icpFit * 40);

  const weight = clickWeight(input.lastClickAt, now);
  if (input.trackableSends > 0) {
    termsUsed.push("click");
    score += Math.round(40 * weight);
    // A second click is a person coming back, which is worth more than a longer first visit.
    if (input.clicks > 1 && weight > 0) score += 10;
  }
  if (input.opens > 0) {
    // Recorded so a reader can see it was there, weighted so no decision rests on it.
    termsUsed.push("open_weak");
    score += 3;
  }

  // Silence is only an answer where the question could be heard. An untracked send tells
  // us nothing about the person, and cooling them for it would be blaming them for a
  // missing pixel.
  const silentFor = input.lastContactedAt ? now - new Date(input.lastContactedAt).getTime() : 0;
  const goneQuiet =
    input.trackableSends > 0 &&
    input.clicks === 0 &&
    silentFor > input.silenceDays * DAY;
  // Only listed where it actually bears on the reading. A person who clicked has answered,
  // and saying their score involved "silence" reads as a contradiction on the page.
  if (input.lastContactedAt && input.trackableSends > 0 && input.clicks === 0) termsUsed.push("silence");

  if (goneQuiet) return { score: 0, band: "dead", computedAt: new Date(now), termsUsed };

  const band = weight > 0 ? "hot" : score >= WARM_SCORE ? "warm" : "cold";
  return { score: Math.min(score, 100), band, computedAt: new Date(now), termsUsed };
}

export interface RecomputeSummary {
  examined: number;
  changed: number;
  bands: Record<string, number>;
  /** Queued messages whose date moved because the person's band did. */
  rescheduled: number;
  /** People who went hot and were handed to a session to react to. */
  escalated: number;
  /** People who went hot and were offered a way to reach us. */
  accessOffered: number;
}

/**
 * Refreshes temperature for people in flight, oldest reading first.
 *
 * Runs on the tick rather than on each signal because half of it is decay: nothing happens
 * when someone goes quiet, and a clock is the only thing that can notice.
 */
export async function recomputeTemps(
  orgId: string,
  productId: string,
  limit = 100,
  now = new Date(),
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

  const instances = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, status: "active" }, { projection: { personId: 1, goalKey: 1 } })
    .limit(limit * 4)
    .toArray();
  if (instances.length === 0) return summary;

  const goals = await db.collection(C.goals).find({ orgId, productId }).toArray();
  const silenceByGoal = new Map<string, number>(
    goals.map((g) => [
      String(g.key),
      Number((g.failure as { silenceDays?: number } | undefined)?.silenceDays ?? 30),
    ]),
  );

  const people = await db
    .collection(C.people)
    .find(
      { _id: { $in: instances.map((i) => new ObjectId(String(i.personId))) } },
      { projection: { belief: 1, temp: 1, lastContactedAt: 1 } },
    )
    // Oldest reading first, so a bounded run still works its way round everybody.
    .sort({ "temp.computedAt": 1 })
    .limit(limit)
    .toArray();
  if (people.length === 0) return summary;

  const ids = people.map((p) => String(p._id));
  const engagement = new Map<string, { trackable: number; clicks: number; opens: number; lastClickAt?: Date }>();
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
          opens: { $sum: { $cond: [{ $ifNull: ["$firstOpenedAt", false] }, 1, 0] } },
          lastClickAt: { $max: "$firstClickedAt" },
        },
      },
    ])
    .toArray();
  for (const r of rows) {
    engagement.set(String(r._id), {
      trackable: r.trackable,
      clicks: r.clicks,
      opens: r.opens,
      lastClickAt: r.lastClickAt ?? undefined,
    });
  }

  const goalByPerson = new Map<string, string>(
    instances.map((i) => [String(i.personId), String(i.goalKey)]),
  );
  const instanceByPerson = new Map<string, string>(
    instances.map((i) => [String(i.personId), String(i._id)]),
  );

  for (const person of people) {
    const personId = String(person._id);
    const belief = person.belief as { icpFit?: number; fitKnown?: boolean } | undefined;
    const seen = engagement.get(personId) ?? { trackable: 0, clicks: 0, opens: 0 };

    const next = computeTemp({
      icpFit: Number(belief?.icpFit ?? 0),
      fitKnown: belief?.fitKnown !== false,
      trackableSends: seen.trackable,
      clicks: seen.clicks,
      opens: seen.opens,
      lastClickAt: seen.lastClickAt,
      lastContactedAt: person.lastContactedAt as Date | undefined,
      silenceDays: silenceByGoal.get(goalByPerson.get(personId) ?? "") ?? 30,
    });

    summary.examined++;
    summary.bands[next.band] = (summary.bands[next.band] ?? 0) + 1;

    const current = person.temp as { band?: string; score?: number } | undefined;
    // The timestamp is written either way, so an unchanged reading still moves to the back
    // of the queue and a bounded run does not re-examine the same people forever.
    if (current?.band === next.band && current?.score === next.score) {
      await db
        .collection(C.people)
        .updateOne({ _id: person._id }, { $set: { "temp.computedAt": next.computedAt } });
      continue;
    }

    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { temp: next } });
    summary.changed++;

    // A band change that stops here changes nothing the recipient can see. Their next
    // message keeps whatever date it was given when the plan was written, so a click at two
    // o'clock moved a score, a band and a colour on a screen, and the person still waited
    // four days for the message that click had earned.
    const moved = await rescheduleFor(orgId, productId, personId, next.band, now);
    summary.rescheduled += moved;

    // Going hot is the one transition worth a session's attention. It means they clicked
    // recently, which is the strongest signal a non-replier ever gives.
    if (next.band === "hot" && current?.band !== "hot") {
      await detectMovement(orgId, productId, {
        personId,
        goalInstanceId: instanceByPerson.get(personId),
        campaignKey: goalByPerson.get(personId),
        reason: "temperature rose to hot",
      });
      summary.escalated++;

      // Telling a person about it was all this used to do, and a lead who has just earned a
      // conversation would then wait for whatever the sequence had scheduled next. The
      // offer goes out now, held for review, because the reason to send it is the thing
      // that just happened.
      if (await offerAccess(orgId, productId, personId, instanceByPerson.get(personId), next.band)) {
        summary.accessOffered++;
      }
    }
  }

  return summary;
}

/**
 * Moves a person's unsent messages to the pace their new temperature deserves.
 *
 * Only messages nobody has approved and nothing has claimed. A message a human read and
 * signed off ships when they expected it to, and one already in the send path is past the
 * point where its date means anything.
 */
async function rescheduleFor(
  orgId: string,
  productId: string,
  personId: string,
  band: string,
  now: Date,
): Promise<number> {
  const db = await getDb();
  const queued = await db
    .collection(C.actions)
    .find({ orgId, productId, personId, status: "queued", reviewedAt: { $exists: false } })
    .toArray();
  if (queued.length === 0) return 0;

  const instance = await db
    .collection(C.goalInstances)
    .findOne({ orgId, productId, personId, status: "active" }, { projection: { goalKey: 1 } });
  const goal = instance
    ? await db.collection(C.goals).findOne({ orgId, productId, key: String(instance.goalKey) })
    : null;
  const person = await db
    .collection(C.people)
    .findOne({ _id: new ObjectId(personId) }, { projection: { lastContactedAt: 1 } });

  let moved = 0;
  for (const action of queued) {
    const wanted = dueAtFor({
      // What remains of the gap the plan asked for, measured from the last contact rather
      // than from when the plan was written.
      offsetDays: gapDaysOf(action, person?.lastContactedAt as Date | undefined),
      band,
      lastContactedAt: person?.lastContactedAt as Date | undefined,
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

/** Exposed for the person page, which shows why a reading is what it is. */
export function explainTemp(temp: Document | null | undefined): string {
  const terms = ((temp?.termsUsed ?? []) as string[]) ?? [];
  if (terms.length === 0) return "not computed yet";
  const parts: string[] = [];
  if (terms.includes("fit_unknown")) parts.push("fit unknown");
  else if (terms.includes("fit")) parts.push("fit");
  if (terms.includes("click")) parts.push("clicks");
  if (terms.includes("open_weak")) parts.push("opens (discounted)");
  if (terms.includes("silence")) parts.push("silence");
  return `from ${parts.join(" + ")}`;
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
  band: string,
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

  // The band has been recomputed but not yet written when this runs, so it is passed in
  // rather than read back off the person — reading would offer the calendar one tick late,
  // and the tick is the whole point.
  const context = { ...(await assetContextFor(orgId, productId, personId, goal)), band };
  const asset = await accessAssetFor(orgId, productId, context);
  if (!asset) return false;

  const channel = await db.collection(C.channels).findOne({
    orgId,
    productId,
    key: { $in: (goal?.allowedChannels ?? ["email"]) as string[] },
    enabled: true,
    status: "healthy",
  });
  if (!channel) return false;

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
      rationale: `Temperature rose to ${band}; offered ${asset.key}.`,
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
    body: `They went ${band}, so a message offering ${asset.key} is waiting in Review.`,
    href: `/products/${productId}/review`,
    // One row per campaign, matching the one message this can ever queue for it.
    dedupeKey: `access_offered:${goalInstanceId}`,
  });

  return true;
}
