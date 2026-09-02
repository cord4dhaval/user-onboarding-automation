import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { RawRecord, SourceAdapter } from "../adapters/source/types.js";
import { isSuppressed } from "./suppression.js";
import { pickChannel } from "./channels.js";
import { nextSendableAt } from "./time.js";
import type { ChannelKey } from "../schemas/common.js";

export interface IngestSummary {
  fetched: number;
  created: number;
  attachedToExisting: number;
  suppressed: number;
  filteredOut: number;
  firstTouchesQueued: number;
  errors: string[];
  /** Where the source got to. Persisted by the caller once the batch is committed. */
  nextCursor?: string;
}

interface SourceDoc {
  _id: ObjectId;
  orgId: string;
  productId: string;
  kind: string;
  triggerMode: "realtime" | "batch";
  fieldMap: Record<string, string>;
  dedupeKey: string;
  cursor?: string;
  defaultGoalKey: string;
  desiredIntervalSec?: number;
  effectiveIntervalSec?: number;
}

interface GoalDoc {
  key: string;
  entry: { minIcpFit: number };
  budget: { touches: number; days: number; usd: number };
  firstTouch: { templateKey: string; channels: ChannelKey[] };
  schedule: { tickEverySec: number; quietHours?: [number, number] };
}

/**
 * Applies the source's field map, so arbitrary column names land in our own shape.
 *
 * Falls back to a case-insensitive match on the column name. Exports differ on
 * capitalisation constantly — "Email" one week, "email" the next — and a mapping that is
 * right except for a capital letter should not silently drop every row.
 */
function mapRecord(raw: RawRecord, fieldMap: Record<string, string>): Record<string, unknown> {
  const lowered = new Map(Object.keys(raw).map((key) => [key.toLowerCase().trim(), key]));
  const mapped: Record<string, unknown> = {};

  for (const [ours, theirs] of Object.entries(fieldMap)) {
    const key = theirs in raw ? theirs : lowered.get(theirs.toLowerCase().trim());
    const value = key === undefined ? undefined : raw[key];
    if (value !== undefined && value !== null && value !== "") mapped[ours] = value;
  }
  return mapped;
}

/**
 * The single ingest path. Webhook push, cron poll and a Claude tool call all arrive here,
 * so behaviour cannot drift between them.
 *
 * The cursor is advanced by the caller only after this returns — advancing it first means
 * a crash mid-batch loses those leads permanently and silently.
 */
export async function ingest(source: SourceDoc, adapter: SourceAdapter): Promise<IngestSummary> {
  const db = await getDb();
  const now = new Date();
  const summary: IngestSummary = {
    fetched: 0,
    created: 0,
    attachedToExisting: 0,
    suppressed: 0,
    filteredOut: 0,
    firstTouchesQueued: 0,
    errors: [],
  };

  const goal = (await db
    .collection(C.goals)
    .findOne({ orgId: source.orgId, productId: source.productId, key: source.defaultGoalKey })) as GoalDoc | null;
  if (!goal) throw new Error(`goal "${source.defaultGoalKey}" not found for this product`);

  const { records, nextCursor } = await adapter.fetch(source.cursor);
  summary.fetched = records.length;
  summary.nextCursor = nextCursor;

  for (const raw of records) {
    try {
      const mapped = mapRecord(raw, source.fieldMap);
      const dedupeValue = String(mapped[source.dedupeKey] ?? "").trim().toLowerCase();
      if (!dedupeValue) {
        summary.filteredOut++;
        continue;
      }

      if (await isSuppressed(source.orgId, [dedupeValue])) {
        summary.suppressed++;
        continue;
      }

      const existing = await db.collection(C.people).findOne({
        orgId: source.orgId,
        productId: source.productId,
        "identities.value": dedupeValue,
      });

      let personId: ObjectId;
      if (existing) {
        personId = existing._id;
        // A returning person gets another arrival rather than a second record.
        await db.collection(C.people).updateOne({ _id: personId }, {
          $push: { arrivals: { sourceId: String(source._id), kind: String(source.kind), at: now } },
        } as never);
        summary.attachedToExisting++;
      } else {
        personId = new ObjectId();
        await db.collection(C.people).insertOne({
          _id: personId,
          orgId: source.orgId,
          productId: source.productId,
          identities: [{ kind: "email", value: dedupeValue, verified: false }],
          primaryEmail: mapped.email ?? dedupeValue,
          name: mapped.name,
          role: mapped.role,
          companyDomain: typeof mapped.company_domain === "string"
            ? mapped.company_domain
            : dedupeValue.split("@")[1],
          timezone: typeof mapped.timezone === "string" ? mapped.timezone : "UTC",
          language: "en",
          stage: "lead",
          consent: {
            state: source.triggerMode === "realtime" ? "opt_in" : "legitimate_interest",
            capturedAt: now,
            evidence: `source:${String(source._id)}`,
          },
          needsClassification: true,
          sourceId: String(source._id),
          // Every arrival is kept, so someone who keeps circling is visible as such.
          arrivals: [{ sourceId: String(source._id), kind: String(source.kind), at: now }],
          lifecycle: "new",
          attempts: 0,
          objections: [],
          investment: { messages: 0, usd: 0, enrichmentCalls: 0, assetsGenerated: 0, campaignsRun: 0 },
          createdAt: now,
        });
        summary.created++;
      }

      // One active goal instance per person, per product. A second one means two agents
      // messaging the same human with different plans — incoherence a customer will notice.
      const openGoal = await db.collection(C.goalInstances).findOne({
        orgId: source.orgId,
        productId: source.productId,
        personId: String(personId),
        status: "active",
      });
      if (openGoal) continue;

      const goalInstanceId = new ObjectId();
      await db.collection(C.goalInstances).insertOne({
        _id: goalInstanceId,
        orgId: source.orgId,
        productId: source.productId,
        personId: String(personId),
        goalKey: goal.key,
        status: "active",
        spent: { touches: 0, usd: 0 },
        deadline: new Date(now.getTime() + goal.budget.days * 86_400_000),
        nextTickAt: new Date(now.getTime() + goal.schedule.tickEverySec * 1000),
        // Checked an hour in: long enough for a fast signup to have happened, short enough
        // that we stop chasing them almost immediately when it has.
        nextVerifyAt: new Date(now.getTime() + 60 * 60_000),
        startedAt: now,
      });

      await db.collection(C.people).updateOne({ _id: personId }, {
        $set: { lifecycle: "active" },
        $inc: { attempts: 1, "investment.campaignsRun": 1 },
        $unset: { coolingUntil: "" },
      });

      const queued = await queueFirstTouch({
        orgId: source.orgId,
        productId: source.productId,
        personId: String(personId),
        goalInstanceId: String(goalInstanceId),
        goal,
        triggerMode: source.triggerMode,
        now,
      });
      if (queued) summary.firstTouchesQueued++;
    } catch (err) {
      summary.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return summary;
}

/**
 * The first touch is deterministic: a pre-approved template on the first healthy channel,
 * queued the moment the lead lands. It does not wait for a Claude session, because
 * speed-to-lead is worth more than the extra personalisation a session would add.
 */
async function queueFirstTouch(args: {
  orgId: string;
  productId: string;
  personId: string;
  goalInstanceId: string;
  goal: GoalDoc;
  triggerMode: "realtime" | "batch";
  now: Date;
}): Promise<boolean> {
  const db = await getDb();
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(args.personId) });
  if (!person) return false;

  const pick = await pickChannel(
    args.orgId,
    args.productId,
    args.goal.firstTouch.channels,
    person as unknown as { consent: { state: string }; stage?: string },
  );
  if (!pick) return false;

  // A campaign names a template key, not one document: the same key exists once per
  // channel and again per segment, and the channel is only known here. findOne over that
  // set returned whichever document Mongo reached first, so a lead could be sent a
  // segment's mail on the strength of nothing at all.
  //
  // A lead who has just arrived has no segment yet — they are classified later — so the
  // product default is the only honest pick for them.
  const candidates = await db
    .collection(C.templates)
    .find({
      orgId: args.orgId,
      productId: args.productId,
      key: args.goal.firstTouch.templateKey,
      channel: pick.key,
      status: "active",
    })
    .toArray();

  const segment = typeof person.segment === "string" ? person.segment : undefined;
  const template =
    (segment && candidates.find((t) => t.scope === "segment" && t.segmentKey === segment)) ||
    candidates.find((t) => t.scope === "product_default") ||
    candidates[0];
  if (!template) return false;

  const dueAt = nextSendableAt(
    args.now,
    String(person.timezone ?? "UTC"),
    args.triggerMode,
    args.goal.schedule.quietHours,
  );

  // Written before any provider call and enforced by a unique index, so a retry or an
  // overlapping run cannot send the same welcome twice.
  const idempotencyKey = `${args.goalInstanceId}:first_touch:${args.goal.firstTouch.templateKey}`;

  try {
    await db.collection(C.actions).insertOne({
      _id: new ObjectId(),
      orgId: args.orgId,
      productId: args.productId,
      goalInstanceId: args.goalInstanceId,
      personId: args.personId,
      channel: pick.key,
      channelId: pick.channelId,
      templateId: String(template._id),
      angle: "welcome",
      rationale: `First touch for goal ${args.goal.key}; ${pick.reason}.`,
      idempotencyKey,
      status: "queued",
      dueAt,
      cost: 0,
      signals: [],
      next: {},
      content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
      assetIds: [],
    });
    return true;
  } catch (err) {
    // Duplicate key means it is already queued. That is the index doing its job.
    if (err instanceof Error && err.message.includes("E11000")) return false;
    throw err;
  }
}
