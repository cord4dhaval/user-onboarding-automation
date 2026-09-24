import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { holdCampaigns, liftHold } from "./campaignRules.js";
import { stampGoalOutcome } from "./outcomes.js";
import { notify } from "./notify.js";

/**
 * What a sales team's "lost" means for our campaigns.
 *
 * The CRM has one word for three different endings, and until now we treated all three the
 * same way: we ignored them. Thirteen leads were marked lost on this product and kept being
 * written to — thirty-eight messages, thirteen opens, no replies. Sending more of the same
 * was not working, but stopping everyone would have been worse, because a third of them had
 * never said no at all. The rep could simply not get them on the phone.
 *
 * So the reason the rep typed is read once, and it decides which of three things happens:
 *
 *   reachable   The rep never got through — a dead number, a lead who does not remember
 *               enquiring, a record closed with no reason at all. Nothing changes. Email is
 *               the channel that still reaches these people, and one of them has opened two
 *               of the three messages sent since she was written off.
 *
 *   wrong_need  They wanted something we do not have. The campaigns end, and what they asked
 *               for is written on the person, so the day we build it there is a list of the
 *               people who asked. Four of thirteen here wanted field-staff tracking, which is
 *               worth more as a product signal than any follow-up would have been.
 *
 *   competitor  They bought elsewhere, or what they have is fine. That is a no today and not
 *               a no forever, so the campaigns sleep. Contracts end.
 *
 * Only the words can tell these apart — "IT Company." is not a reason, and neither is a typo
 * about tracking field employees — so a session reads them and calls classify_lost. The
 * engine does not guess.
 *
 * Three doors open a held campaign early: the CRM reopens the lead, they write to us, or we
 * ship what they asked for. The first two lift the hold on their own; the third is a campaign
 * somebody writes on purpose, to people who asked for exactly that.
 */

export const LOST_BUCKETS = ["reachable", "wrong_need", "competitor"] as const;
export type LostBucket = (typeof LOST_BUCKETS)[number];

/** How long a lead who bought elsewhere is left alone. About the length of a trial they just started. */
export const REVIVE_AFTER_DAYS = 90;

/**
 * How long a lead we cannot serve is left alone. Twice the other, because nothing they said
 * changes until we build something, and that is not a season's work.
 */
const WRONG_NEED_COOLING_DAYS = 180;

const DAY = 86_400_000;

/** A CRM record that says lost, however that CRM words it. */
const LOST_MATCH: Document = {
  $or: [
    { "snapshot.lostAt": { $exists: true, $ne: null } },
    { "snapshot.status": { $regex: /lost/i } },
    { "snapshot.stage": { $regex: /lost/i } },
  ],
};

export interface LostLead {
  person_id: string;
  name: string;
  lost_at: string | null;
  /** What the rep typed. The only thing that can say which bucket this is. */
  reason: string;
  campaigns: string[];
  /** Messages already written and waiting, which is what this decision is about. */
  queued: number;
}

/**
 * Leads the CRM says are lost and nobody has read the reason of yet.
 *
 * Their waiting messages are counted here rather than left to be discovered, because that
 * number is the cost of not deciding: every one of them goes out while the row sits unread.
 */
export async function lostNeedingBucket(orgId: string, productId: string, limit = 25): Promise<LostLead[]> {
  const db = await getDb();
  const links = await db
    .collection(C.crmLinks)
    .find({ orgId, productId, personId: { $exists: true, $ne: null }, lostBucket: { $exists: false }, ...LOST_MATCH })
    .sort({ "snapshot.lostAt": 1 })
    .limit(limit)
    .toArray();

  const out: LostLead[] = [];
  for (const link of links) {
    const personId = String(link.personId);
    const instances = await db
      .collection(C.goalInstances)
      .find({ orgId, productId, personId, status: "active" })
      .project({ _id: 1, goalKey: 1 })
      .toArray();
    const queued = instances.length
      ? await db.collection(C.actions).countDocuments({
          orgId,
          productId,
          goalInstanceId: { $in: instances.map((i) => String(i._id)) },
          status: { $in: ["queued", "awaiting_approval"] },
        })
      : 0;
    const snapshot = (link.snapshot ?? {}) as Record<string, unknown>;
    out.push({
      person_id: personId,
      name: String(snapshot.name ?? ""),
      lost_at: snapshot.lostAt ? new Date(snapshot.lostAt as Date).toISOString() : null,
      reason: String(snapshot.lostReason ?? "").trim(),
      campaigns: instances.map((i) => String(i.goalKey)),
      queued,
    });
  }
  return out;
}

export interface ApplyLostInput {
  orgId: string;
  productId: string;
  personId: string;
  bucket: LostBucket;
  /** For wrong_need: what they asked for that we do not have, in their own terms. */
  need?: string;
  /** What in the rep's words puts them in this bucket. */
  why: string;
  now?: Date;
}

export interface ApplyLostResult {
  bucket: LostBucket;
  campaigns: number;
  messages_dropped: number;
  /** When the campaigns wake up again, for competitor. */
  until: string | null;
  need: string | null;
}

/**
 * Applies one bucket to one person, across every campaign they are in.
 *
 * Across every campaign on purpose: a lost lead here sits in email, WhatsApp and LinkedIn at
 * once, and stopping only the one whose message happened to be next would have looked, from
 * where they sit, like no change at all.
 */
export async function applyLostBucket(input: ApplyLostInput): Promise<ApplyLostResult> {
  const db = await getDb();
  const now = input.now ?? new Date();
  const { orgId, productId, personId } = input;

  const link = await db.collection(C.crmLinks).findOne({ orgId, productId, personId, ...LOST_MATCH });
  const lostAt = link?.snapshot?.lostAt ? new Date(link.snapshot.lostAt as Date) : now;

  const instances = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, personId, status: "active" })
    .project({ _id: 1, goalKey: 1 })
    .toArray();
  const ids = instances.map((i) => String(i._id));

  const result: ApplyLostResult = {
    bucket: input.bucket,
    campaigns: ids.length,
    messages_dropped: 0,
    until: null,
    need: input.need?.trim() || null,
  };

  if (input.bucket === "wrong_need") {
    for (const id of ids) {
      await db.collection(C.goalInstances).updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "failed", endedAt: now, outcome: `lost in CRM: ${input.why}`, decidedBy: "claude" } },
      );
      await stampGoalOutcome(orgId, id, "lost");
    }
    const dropped = await db.collection(C.actions).updateMany(
      { orgId, productId, goalInstanceId: { $in: ids }, status: { $in: ["queued", "awaiting_approval"] }, angle: { $ne: "reply" } },
      { $set: { status: "skipped", skipReason: `CRM lost: we do not have what they asked for (${input.why})` } },
    );
    result.messages_dropped = dropped.modifiedCount;

    // The need outlives the campaign that heard it. This is the list a feature campaign is
    // written from later, and until then it is the only count of what we are losing deals on.
    await db.collection(C.people).updateOne(
      { _id: new ObjectId(personId) },
      {
        $set: {
          lifecycle: "cooling",
          coolingUntil: new Date(now.getTime() + WRONG_NEED_COOLING_DAYS * DAY),
          ...(result.need ? { parkedNeed: result.need, parkedNeedAt: now } : {}),
        },
      },
    );
  }

  if (input.bucket === "competitor") {
    const until = new Date(lostAt.getTime() + REVIVE_AFTER_DAYS * DAY);
    const before = await db.collection(C.actions).countDocuments({
      orgId,
      productId,
      goalInstanceId: { $in: ids },
      status: { $in: ["queued", "awaiting_approval"] },
      angle: { $ne: "reply" },
    });
    await holdCampaigns({
      orgId,
      productId,
      goalInstanceIds: ids,
      until,
      reason: `CRM lost: ${input.why}`,
      kind: "lost",
      queued: "drop",
      now,
    });
    result.messages_dropped = before;
    result.until = until.toISOString();
  }

  // reachable changes nothing: they never said no, and email is the door the phone could not
  // open. The label is written all the same, so the decision is visible and countable.

  await db.collection(C.crmLinks).updateMany(
    { orgId, productId, personId },
    {
      $set: {
        lostBucket: input.bucket,
        lostBucketAt: now,
        lostBucketWhy: input.why,
        ...(result.need ? { lostNeed: result.need } : {}),
      },
    },
  );

  await db.collection(C.events).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    personId,
    source: "claude",
    type: "crm_lost_applied",
    payload: {
      bucket: input.bucket,
      why: input.why,
      need: result.need,
      campaigns: result.campaigns,
      messages_dropped: result.messages_dropped,
      until: result.until,
    },
    ts: now,
  });

  return result;
}

/**
 * Undoes a lost decision when the person stops being lost — the CRM reopens them, or they
 * write to us themselves.
 *
 * Campaigns that were ended for wrong_need stay ended: that was a verdict about what we sell,
 * and it does not change because a rep reopened a record. What lifts is the sleeping, which
 * was only ever a wait.
 */
export async function liftLost(orgId: string, productId: string, personId: string, why: string): Promise<number> {
  const db = await getDb();
  const lifted = await liftHold({ orgId, productId, personId, kind: "lost", reason: why });
  await db
    .collection(C.crmLinks)
    .updateMany({ orgId, productId, personId }, { $unset: { lostBucket: "", lostBucketAt: "", lostBucketWhy: "" } });
  return lifted;
}

/** How many mails a written-off lead has to open before it is worth telling anyone. One is an accident. */
const READING_OPENS = 2;
/** The window those opens have to fall in, so this says "this week" rather than "at some point". */
const READING_DAYS = 7;

/**
 * Tells the team when a lead they gave up on is reading us anyway.
 *
 * This is the one thing the CRM cannot work out for itself. A rep marks a lead lost because
 * the phone went unanswered; what happens next lives here, in opens they never see. Gummadi
 * Srilakshmi was closed with "contact number does not exists" and then opened two of the
 * three mails that followed — free pipeline nobody knew about, on a lead whose only fault was
 * a wrong phone number.
 *
 * Machine opens do not count: a scan is moved to its own field the moment it is recognised
 * (engine/engagement.ts), so a gateway cannot resurrect anybody.
 */
export async function noticeLostButReading(orgId: string, productId: string, now = new Date()): Promise<number> {
  const db = await getDb();
  const since = new Date(now.getTime() - READING_DAYS * DAY);
  const links = await db
    .collection(C.crmLinks)
    .find({ orgId, productId, lostBucket: { $exists: true }, personId: { $exists: true, $ne: null } })
    .project({ personId: 1, snapshot: 1, lostBucket: 1 })
    .toArray();

  let told = 0;
  for (const link of links) {
    const personId = String(link.personId);
    const opens = await db
      .collection(C.actions)
      .countDocuments({ orgId, productId, personId, firstOpenedAt: { $gte: since } });
    if (opens < READING_OPENS) continue;

    const snapshot = (link.snapshot ?? {}) as Record<string, unknown>;
    const name = String(snapshot.name ?? "This lead");
    const lostAt = snapshot.lostAt ? new Date(snapshot.lostAt as Date) : null;
    await notify({
      orgId,
      productId,
      severity: "good",
      // One row per person, bumped rather than repeated: the point is that they are reading,
      // not how many times we have noticed.
      dedupeKey: `lost-reading:${personId}`,
      title: `${name} was marked lost and is still reading our mail`,
      body:
        `${opens} mails opened in the last ${READING_DAYS} days` +
        (lostAt ? `, after the CRM closed them on ${lostAt.toISOString().slice(0, 10)}` : "") +
        (snapshot.lostReason ? ` ("${String(snapshot.lostReason).slice(0, 80)}")` : "") +
        ". Worth another call.",
      href: `/people/${personId}`,
    });
    told++;
  }
  return told;
}
