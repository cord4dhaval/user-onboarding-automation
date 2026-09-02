import { ObjectId, type AnyBulkWriteOperation, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { RawRecord, SourceAdapter } from "../adapters/source/types.js";
import { loadChannels, pickChannelFrom } from "./channels.js";
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

/** A duplicate key is the unique index doing its job. Anything else is a real failure. */
function insertedDespiteDuplicates(err: unknown): number | null {
  const bulk = err as { result?: { insertedCount?: number }; writeErrors?: { code?: number }[] };
  const writeErrors = bulk?.writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.some((e) => e.code !== 11000)) return null;
  return bulk.result?.insertedCount ?? 0;
}

/**
 * The single ingest path. Webhook push, cron poll and a Claude tool call all arrive here,
 * so behaviour cannot drift between them.
 *
 * Written as phases over the whole batch rather than as a loop over one person at a time.
 * The per-person version issued about ten round trips each, and a round trip to a hosted
 * cluster is ~20ms, so a hundred rows took three minutes and ten thousand were not
 * possible at all. Nothing here depends on the row before it, so the same work fits in a
 * fixed handful of queries whatever the batch size.
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
  if (records.length === 0) return summary;

  // One batch can name the same person twice — a spreadsheet with a repeated row, a poll
  // that overlaps its own window. Grouping first means one person document and two
  // arrivals, which is what the per-person version produced by re-reading its own write.
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const raw of records) {
    const mapped = mapRecord(raw, source.fieldMap);
    const value = String(mapped[source.dedupeKey] ?? "").trim().toLowerCase();
    if (!value) {
      summary.filteredOut++;
      continue;
    }
    const bucket = groups.get(value);
    if (bucket) bucket.push(mapped);
    else groups.set(value, [mapped]);
  }
  if (groups.size === 0) return summary;

  // Suppression is permanent and global to the tenant, so it is checked before anything
  // is written — an unsubscribe from one goal silences every goal.
  const suppressed = await db
    .collection(C.suppressions)
    .find({ orgId: source.orgId, identityValue: { $in: [...groups.keys()] } })
    .project({ identityValue: 1 })
    .toArray();
  for (const doc of suppressed) {
    const value = String(doc.identityValue);
    summary.suppressed += groups.get(value)?.length ?? 0;
    groups.delete(value);
  }
  if (groups.size === 0) return summary;

  const values = [...groups.keys()];
  const wanted = new Set(values);
  const existing = await db
    .collection(C.people)
    .find({ orgId: source.orgId, productId: source.productId, "identities.value": { $in: values } })
    .toArray();

  const byValue = new Map<string, Document>();
  for (const person of existing) {
    for (const identity of (person.identities ?? []) as { value?: unknown }[]) {
      const value = String(identity.value ?? "").trim().toLowerCase();
      if (wanted.has(value)) byValue.set(value, person);
    }
  }

  const arrival = { sourceId: String(source._id), kind: String(source.kind), at: now };
  const newPeople: Document[] = [];
  const attachments: AnyBulkWriteOperation<Document>[] = [];
  const entries: { personId: ObjectId; person: Document }[] = [];

  for (const [value, rows] of groups) {
    const found = byValue.get(value);
    if (found) {
      // A returning person gets another arrival rather than a second record.
      attachments.push({
        updateOne: {
          filter: { _id: found._id },
          update: { $push: { arrivals: { $each: rows.map(() => arrival) } } } as never,
        },
      });
      summary.attachedToExisting += rows.length;
      entries.push({ personId: found._id as ObjectId, person: found });
      continue;
    }

    const mapped = rows[0] ?? {};
    const personId = new ObjectId();
    const person: Document = {
      _id: personId,
      orgId: source.orgId,
      productId: source.productId,
      identities: [{ kind: "email", value, verified: false }],
      primaryEmail: mapped.email ?? value,
      name: mapped.name,
      role: mapped.role,
      companyDomain: typeof mapped.company_domain === "string" ? mapped.company_domain : value.split("@")[1],
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
      arrivals: rows.map(() => arrival),
      lifecycle: "new",
      attempts: 0,
      objections: [],
      investment: { messages: 0, usd: 0, enrichmentCalls: 0, assetsGenerated: 0, campaignsRun: 0 },
      createdAt: now,
    };
    newPeople.push(person);
    summary.created++;
    // Repeats of a person this batch has just created are arrivals on that one record.
    summary.attachedToExisting += rows.length - 1;
    entries.push({ personId, person });
  }

  if (newPeople.length > 0) await db.collection(C.people).insertMany(newPeople, { ordered: false });
  if (attachments.length > 0) await db.collection(C.people).bulkWrite(attachments, { ordered: false });

  // One active goal instance per person, per product. A second one means two agents
  // messaging the same human with different plans — incoherence a customer will notice.
  const personIds = entries.map((e) => String(e.personId));
  const openGoals = await db
    .collection(C.goalInstances)
    .find({ orgId: source.orgId, productId: source.productId, personId: { $in: personIds }, status: "active" })
    .project({ personId: 1 })
    .toArray();
  const alreadyOpen = new Set(openGoals.map((g) => String(g.personId)));

  // The instance id is minted with the entry rather than read back off a parallel array,
  // so the first touch cannot be attributed to the person standing next to its owner.
  const starting = entries
    .filter((e) => !alreadyOpen.has(String(e.personId)))
    .map((e) => ({ ...e, goalInstanceId: new ObjectId() }));
  if (starting.length === 0) return summary;

  const instances = starting.map((e) => ({
    _id: e.goalInstanceId,
    orgId: source.orgId,
    productId: source.productId,
    personId: String(e.personId),
    goalKey: goal.key,
    status: "active",
    spent: { touches: 0, usd: 0 },
    deadline: new Date(now.getTime() + goal.budget.days * 86_400_000),
    nextTickAt: new Date(now.getTime() + goal.schedule.tickEverySec * 1000),
    // Checked an hour in: long enough for a fast signup to have happened, short enough
    // that we stop chasing them almost immediately when it has.
    nextVerifyAt: new Date(now.getTime() + 60 * 60_000),
    startedAt: now,
  }));
  await db.collection(C.goalInstances).insertMany(instances, { ordered: false });

  await db.collection(C.people).bulkWrite(
    starting.map((e) => ({
      updateOne: {
        filter: { _id: e.personId },
        update: {
          $set: { lifecycle: "active" },
          $inc: { attempts: 1, "investment.campaignsRun": 1 },
          $unset: { coolingUntil: "" },
        },
      },
    })),
    { ordered: false },
  );

  await queueFirstTouches({
    source,
    goal,
    now,
    starting: starting.map((e) => ({ person: e.person, goalInstanceId: String(e.goalInstanceId) })),
    summary,
  });

  return summary;
}

/**
 * The first touch is deterministic: a pre-approved template on the first healthy channel,
 * queued the moment the lead lands. It does not wait for a Claude session, because
 * speed-to-lead is worth more than the extra personalisation a session would add.
 *
 * Channels and templates are the same few documents for everyone in the batch, so they
 * are read once and the per-person decision is made in memory.
 */
async function queueFirstTouches(args: {
  source: SourceDoc;
  goal: GoalDoc;
  now: Date;
  starting: { person: Document; goalInstanceId: string }[];
  summary: IngestSummary;
}): Promise<void> {
  const db = await getDb();
  const { source, goal, now, summary } = args;

  const channels = await loadChannels(source.orgId, source.productId, goal.firstTouch.channels);
  // A campaign names a template key, not one document: the same key exists once per
  // channel and again per segment, and the channel is only known per person. findOne over
  // that set returned whichever document Mongo reached first, so a lead could be sent a
  // segment's mail on the strength of nothing at all.
  const templates = await db
    .collection(C.templates)
    .find({
      orgId: source.orgId,
      productId: source.productId,
      key: goal.firstTouch.templateKey,
      channel: { $in: goal.firstTouch.channels },
      status: "active",
    })
    .toArray();

  const actions: Document[] = [];
  for (const { person, goalInstanceId } of args.starting) {
    const pick = pickChannelFrom(channels, goal.firstTouch.channels, person as never);
    if (!pick) continue;

    // A lead who has just arrived has no segment yet — they are classified later — so the
    // product default is the only honest pick for them.
    const candidates = templates.filter((t) => t.channel === pick.key);
    const segment = typeof person.segment === "string" ? person.segment : undefined;
    const template =
      (segment && candidates.find((t) => t.scope === "segment" && t.segmentKey === segment)) ||
      candidates.find((t) => t.scope === "product_default") ||
      candidates[0];
    if (!template) continue;

    actions.push({
      _id: new ObjectId(),
      orgId: source.orgId,
      productId: source.productId,
      goalInstanceId,
      personId: String(person._id),
      channel: pick.key,
      channelId: pick.channelId,
      templateId: String(template._id),
      angle: "welcome",
      rationale: `First touch for goal ${goal.key}; ${pick.reason}.`,
      // Written before any provider call and enforced by a unique index, so a retry or an
      // overlapping run cannot send the same welcome twice.
      idempotencyKey: `${goalInstanceId}:first_touch:${goal.firstTouch.templateKey}`,
      status: "queued",
      dueAt: nextSendableAt(now, String(person.timezone ?? "UTC"), source.triggerMode, goal.schedule.quietHours),
      cost: 0,
      signals: [],
      next: {},
      content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
      assetIds: [],
    });
  }
  if (actions.length === 0) return;

  try {
    const result = await db.collection(C.actions).insertMany(actions, { ordered: false });
    summary.firstTouchesQueued += result.insertedCount;
  } catch (err) {
    const inserted = insertedDespiteDuplicates(err);
    if (inserted === null) throw err;
    summary.firstTouchesQueued += inserted;
  }
}
