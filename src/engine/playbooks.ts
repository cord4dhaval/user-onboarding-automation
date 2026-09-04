import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * A playbook is a plan with nobody in it: the ordered steps for one segment of one
 * campaign, written once and copied onto everybody who joins that segment.
 *
 * The audit that produced this file found 204 per-person plans collapsing into 49 distinct
 * shapes, the largest of them used 26 times, each produced by its own model call. The
 * variation between them was mostly the wording of the angle and a day or two of drift —
 * not 204 strategies, one strategy per segment plus noise. Meanwhile the routine writing
 * them managed forty people an hour against a hundred arriving, so the backlog grew by
 * sixty an hour and could never drain.
 *
 * The inversion is the point. Today a person waits for a model before they have any
 * sequence at all; here they are stamped with their segment's playbook within seconds of
 * arriving, and a session improves that later only where the improvement is worth paying
 * for. A generic but correct sequence sent today beats a bespoke one written on day sixteen.
 */

export interface PlaybookStep {
  id: number;
  /** Days after the previous touch, as an intention. Cadence decides the real date. */
  offsetDays: number;
  channel: string;
  angle: string;
  why: string;
  /** Optional: the ladder rung to render through. Left unset, send time decides. */
  templateKey?: string;
}

export interface Playbook extends Document {
  orgId: string;
  productId: string;
  goalKey: string;
  /** `default` is the fallback used until somebody has been classified. */
  segmentKey: string;
  steps: PlaybookStep[];
  version: number;
  rationale?: string;
  createdBy: string;
  updatedAt: Date;
}

/**
 * The playbook a person should be running, with a fallback to the campaign's default.
 *
 * A lead who has just arrived has no segment — they are classified an hour later — so the
 * default is not an edge case, it is the path every single person takes first.
 */
export async function playbookFor(
  orgId: string,
  productId: string,
  goalKey: string,
  segmentKey?: string,
): Promise<Playbook | null> {
  const db = await getDb();
  const candidates = await db
    .collection(C.playbooks)
    .find({ orgId, productId, goalKey })
    .toArray();
  if (candidates.length === 0) return null;

  const bySegment = segmentKey && candidates.find((p) => String(p.segmentKey) === segmentKey);
  const fallback = candidates.find((p) => String(p.segmentKey) === "default") ?? candidates[0];
  return ((bySegment || fallback) ?? null) as Playbook | null;
}

export interface StampResult {
  stamped: boolean;
  reason: string;
  planId?: string;
}

/**
 * Copies a playbook onto one person's campaign as a real plan.
 *
 * Re-stamping is allowed but deliberately narrow. Classification arrives after the welcome
 * has gone out, and a person who turns out to be an agency owner rather than an engineering
 * leader should get the agency owner's sequence — but only while the sequence is still
 * essentially unspent. Rewriting somebody's plan on their sixth touch would contradict five
 * messages they have already read, so past that point the change is left to a session that
 * can read what was actually said to them.
 */
export async function stampPlaybook(input: {
  orgId: string;
  productId: string;
  goalInstanceId: string;
  goalKey: string;
  segmentKey?: string;
  now?: Date;
}): Promise<StampResult> {
  const db = await getDb();
  const now = input.now ?? new Date();

  const instance = await db
    .collection(C.goalInstances)
    .findOne({ _id: new ObjectId(input.goalInstanceId), orgId: input.orgId });
  if (!instance) return { stamped: false, reason: "goal instance not found" };
  if (instance.status !== "active") return { stamped: false, reason: "campaign is not active" };

  const playbook = await playbookFor(input.orgId, input.productId, input.goalKey, input.segmentKey);
  if (!playbook) return { stamped: false, reason: "no playbook for this campaign yet" };

  const current = instance.currentPlanId
    ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(instance.currentPlanId)) })
    : null;

  if (current) {
    // Already running this exact playbook at this version: nothing to do, and saying so is
    // cheaper than writing an identical plan every minute the tick comes round.
    if (
      String(current.playbookId ?? "") === String(playbook._id) &&
      Number(current.playbookVersion ?? 0) === Number(playbook.version ?? 1)
    ) {
      return { stamped: false, reason: "already running this playbook", planId: String(current._id) };
    }
    // A plan a session wrote for this person specifically outranks any playbook. That plan
    // was written against what they clicked and replied; a segment default knows none of it.
    if (String(current.createdBy ?? "") !== "playbook") {
      return { stamped: false, reason: "person has a bespoke plan", planId: String(current._id) };
    }
    const spent = Number((instance.spent as { touches?: number } | undefined)?.touches ?? 0);
    if (spent > 1) {
      return { stamped: false, reason: `sequence already ${spent} touches in`, planId: String(current._id) };
    }
  }

  const version = Number(current?.version ?? 0) + 1;
  const planId = new ObjectId();
  await db.collection(C.plans).insertOne({
    _id: planId,
    orgId: input.orgId,
    productId: input.productId,
    goalInstanceId: input.goalInstanceId,
    version,
    steps: playbook.steps,
    rationale: `Stamped from the ${playbook.segmentKey} playbook for ${input.goalKey}.`,
    createdBy: "playbook",
    playbookId: String(playbook._id),
    playbookVersion: Number(playbook.version ?? 1),
    segmentKey: playbook.segmentKey,
    createdAt: now,
  });

  await db
    .collection(C.goalInstances)
    .updateOne({ _id: instance._id }, { $set: { currentPlanId: String(planId) } });

  // Steps written before the stamp belong to the plan being replaced. Leaving them queued
  // would send the old segment's third message inside the new segment's sequence.
  await db.collection(C.actions).updateMany(
    {
      orgId: input.orgId,
      goalInstanceId: input.goalInstanceId,
      status: "queued",
      planStepId: { $exists: true },
    },
    { $set: { status: "skipped", skipReason: "plan replaced by playbook stamp" } },
  );

  return { stamped: true, reason: `stamped ${playbook.segmentKey} playbook v${playbook.version}`, planId: String(planId) };
}

/**
 * The segments a product will accept, plus the two answers that are not segments.
 *
 * Classification invented twenty-two segment keys for a product whose config declares two,
 * including `smb_owner_other`, `other_smb_owner` and `smb_owner_services` as three separate
 * buckets holding twenty-seven, nine and three people. Nothing can learn from that: an
 * angle's performance inside a bucket of three is noise, and a playbook per accidental
 * bucket is a playbook nobody maintains.
 *
 * `off_icp` and `unknown` are always allowed, because the honest answers to "who is this"
 * include "not our customer" and "there was nothing here to read".
 */
export async function allowedSegments(orgId: string, productId: string): Promise<string[]> {
  const db = await getDb();
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId });
  const config = (product?.config ?? {}) as { segments?: Array<{ key?: string }> };
  const declared = (config.segments ?? []).map((s) => String(s.key)).filter(Boolean);
  return [...new Set([...declared, "off_icp", "unknown"])];
}
