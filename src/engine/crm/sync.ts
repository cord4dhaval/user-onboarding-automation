import { ObjectId, type Document } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { pluck } from "../../mcp/binding.js";
import type { CrmKind, CrmMap, CrmMatchedBy, CrmMeeting, CrmSnapshot } from "../../schemas/crm.js";
import { CrmClient, RateLimited, dateOf, fingerprint, lowerEmail, phoneKey } from "./client.js";
import { kindOf } from "./map.js";

/**
 * Keeps our own copy of what the sales team's CRM knows about each of our people.
 *
 * Read-only, and additive: nothing here changes what the engine sends. It stores the
 * record, its history, its notes and its meetings in our database so the person's page and
 * the planner can tell the whole story without asking the CRM — and keep telling it when the
 * CRM is unreachable or the connection is later switched off.
 *
 * Three ways in, all idempotent: a person is checked once when we first see them; the
 * CRM's change feed is read every ten minutes; and a backfill walks everybody who has never
 * been checked. Every stored row carries a fingerprint, so reading the same history twice
 * stores it once.
 */

const POLL_EVERY_MS = 10 * 60_000;
/** A change feed that only speaks in days re-reads yesterday, so nothing on the boundary is lost. */
const FEED_OVERLAP_MS = 24 * 60 * 60_000;
const UNMATCHED_RECHECK_MS = 24 * 60 * 60_000;
/** Enough for one person: two lookups and four reads of a record, three seconds apart. */
const PERSON_ROOM_MS = 20_000;

type Row = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  v === null || v === undefined || v === "" ? undefined : String(v);

function snapshotOf(row: Row, map: CrmMap): CrmSnapshot {
  const f = map.fields;
  const get = (path?: string) => (path ? pluck(row, path) : undefined);
  const value = get(f.value);
  return clean({
    name: str(get(f.name)),
    email: lowerEmail(get(f.email)) || undefined,
    phone: str(get(f.phone)),
    status: str(get(f.status)),
    stage: str(get(f.stage)),
    owner: str(get(f.owner)),
    source: str(get(f.source)),
    value: typeof value === "number" ? value : undefined,
    currency: str(get(f.currency)),
    project: str(get(f.project)),
    followUp: dateOf(get(f.followUp)),
    createdAt: dateOf(get(f.createdAt)),
    updatedAt: dateOf(get(f.updatedAt)),
    wonAt: dateOf(get(f.wonAt)),
    lostAt: dateOf(get(f.lostAt)),
    lostReason: str(get(f.lostReason)),
    deleted: get(f.deleted) === true,
  });
}

/** Unset fields are left out rather than stored as nulls a reader has to tell from real values. */
function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function meetingOf(row: Row, map: CrmMap): CrmMeeting | null {
  const f = map.meetingFields;
  if (!f) return null;
  const title = str(pluck(row, f.title));
  if (!title) return null;
  const items = f.actionItems ? pluck(row, f.actionItems) : undefined;
  return clean({
    title,
    start: dateOf(pluck(row, f.start)),
    end: f.end ? dateOf(pluck(row, f.end)) : undefined,
    status: f.status ? str(pluck(row, f.status)) : undefined,
    organizer: f.organizer ? str(pluck(row, f.organizer)) : undefined,
    summary: f.summary ? str(pluck(row, f.summary)) : undefined,
    actionItems: Array.isArray(items) ? items.map(String).filter(Boolean) : undefined,
    nextSteps: f.nextSteps ? str(pluck(row, f.nextSteps)) : undefined,
  });
}

/** Our people this record could be, by the two things a CRM and a form both collect. */
async function candidates(
  orgId: string,
  productId: string,
  email: string,
  phone: string,
): Promise<{ byEmail: Document | null; byPhone: Document[] }> {
  const db = await getDb();
  const people = db.collection(C.people);
  const byEmail = email
    ? await people.findOne({ orgId, productId, "identities.value": email }, { projection: { name: 1, identities: 1 } })
    : null;
  const byPhone = phone
    ? await people
        .find(
          { orgId, productId, "identities.value": { $in: [`+91${phone}`, phone, `91${phone}`, `0${phone}`] } },
          { projection: { name: 1, identities: 1 } },
        )
        .limit(3)
        .toArray()
    : [];
  return { byEmail, byPhone };
}

const nameTokens = (value: unknown): Set<string> =>
  new Set(
    String(value ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((t) => t.length >= 3),
  );

/**
 * Who a record is, or why we will not say.
 *
 * An address is the strong key. A phone alone is weaker — an office line reaches several
 * people, and a form's phone field collects a colleague's number often enough — so a phone
 * match stands on its own only when the names agree, and a phone that points at one of our
 * people while the address points at another is shown for review, never linked.
 */
export function decide(
  snap: CrmSnapshot,
  found: { byEmail: Document | null; byPhone: Document[] },
): { status: "linked" | "review" | "unmatched"; personId?: string; matchedBy?: CrmMatchedBy; why?: string } {
  const { byEmail, byPhone } = found;
  if (byEmail) {
    const emailId = String(byEmail._id);
    if (byPhone.length && !byPhone.some((p) => String(p._id) === emailId)) {
      return { status: "review", personId: emailId, matchedBy: "email", why: "the phone belongs to someone else of ours" };
    }
    return { status: "linked", personId: emailId, matchedBy: byPhone.length ? "email+phone" : "email" };
  }
  if (byPhone.length > 1) return { status: "unmatched", why: "the phone is shared by several of our people" };
  const ours = byPhone.length === 1 ? byPhone[0] : undefined;
  if (ours) {
    const a = nameTokens(snap.name);
    const b = nameTokens(ours.name);
    const agree = a.size === 0 || b.size === 0 || [...a].some((t) => b.has(t));
    return agree
      ? { status: "linked", personId: String(ours._id), matchedBy: "phone" }
      : { status: "review", personId: String(ours._id), matchedBy: "phone", why: "same phone, different name" };
  }
  return { status: "unmatched" };
}

interface ActivityInput {
  at: Date;
  type: string;
  kind: CrmKind;
  text?: string;
  actor?: string;
  meta?: Row;
  fp: string;
}

async function storeActivity(
  client: CrmClient,
  recordId: string,
  personId: string | undefined,
  rows: ActivityInput[],
): Promise<number> {
  if (!rows.length) return 0;
  const db = await getDb();
  const { orgId, productId, connectionId } = client.conn;
  const now = new Date();
  const result = await db.collection(C.crmActivity).bulkWrite(
    rows.map((r) => ({
      updateOne: {
        filter: { orgId, connectionId, fingerprint: r.fp },
        update: {
          $set: clean({ productId, recordId, personId, at: r.at, type: r.type, kind: r.kind, text: r.text, actor: r.actor, meta: r.meta }),
          $setOnInsert: { orgId, connectionId, fingerprint: r.fp, createdAt: now },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return result.upsertedCount;
}

/**
 * Reads one record in full — the record, every event, every note, every meeting — and
 * stores it against the person it belongs to. Safe to repeat.
 */
export async function syncRecord(
  client: CrmClient,
  recordId: string,
  known?: { personId?: string; row?: Row },
): Promise<{ status: string; personId?: string; added: number }> {
  const db = await getDb();
  const { orgId, productId, connectionId, map } = client.conn;
  const links = db.collection(C.crmLinks);

  let row = known?.row;
  if (map.record) {
    const answer = await client.call(map.record.tool, map.record.args, { recordId });
    const picked = map.record.path ? pluck(answer, map.record.path) : answer;
    if (picked && typeof picked === "object") row = picked as Row;
  }
  if (!row) return { status: "missing", added: 0 };
  const snap = snapshotOf(row, map);

  if (map.projects.length && !(snap.project && map.projects.includes(snap.project))) {
    await links.updateOne(
      { orgId, connectionId, externalId: recordId },
      { $set: { productId, status: "out_of_scope", snapshot: snap, checkedAt: new Date() }, $unset: { personId: "" } },
      { upsert: true },
    );
    return { status: "out_of_scope", added: 0 };
  }

  const existing = await links.findOne({ orgId, connectionId, externalId: recordId });
  let verdict: ReturnType<typeof decide>;
  if (existing?.matchedBy === "manual" && existing.personId) {
    verdict = { status: existing.status, personId: String(existing.personId), matchedBy: "manual" };
  } else {
    verdict = decide(snap, await candidates(orgId, productId, snap.email ?? "", phoneKey(snap.phone)));
    // A person checked by their own address found this record, so it is them even when the
    // record's copy of the address is missing or spelled differently.
    if (verdict.status === "unmatched" && known?.personId) {
      verdict = { status: "linked", personId: known.personId, matchedBy: "email" };
    }
  }

  if (verdict.status === "unmatched") {
    await links.updateOne(
      { orgId, connectionId, externalId: recordId },
      {
        $set: { productId, status: "unmatched", snapshot: snap, why: verdict.why, checkedAt: new Date() },
        $unset: { personId: "" },
      },
      { upsert: true },
    );
    return { status: "unmatched", added: 0 };
  }
  const personId = verdict.personId;

  const activity: ActivityInput[] = [];
  const events = await client.list(map.events, { recordId }, 20);
  const ef = map.eventFields;
  const dropNotes = map.notes ? new Set(map.noteEventTypes) : new Set<string>();
  for (const e of events.items) {
    const at = dateOf(pluck(e, ef.at));
    const type = str(pluck(e, ef.type)) ?? "event";
    if (!at || dropNotes.has(type)) continue;
    const text = ef.text ? str(pluck(e, ef.text)) : undefined;
    const actor = ef.actor ? str(pluck(e, ef.actor)) : undefined;
    const id = ef.id ? str(pluck(e, ef.id)) : undefined;
    activity.push({ at, type, kind: kindOf(type, map), text, actor, fp: fingerprint(recordId, id ?? "", at.toISOString(), type, text) });
  }

  if (map.notes && map.noteFields) {
    const nf = map.noteFields;
    const notes = await client.list(map.notes, { recordId }, 10);
    for (const n of notes.items) {
      const at = dateOf(pluck(n, nf.at));
      const text = str(pluck(n, nf.text));
      if (!at || !text) continue;
      const actor = nf.actor ? str(pluck(n, nf.actor)) : undefined;
      const id = nf.id ? str(pluck(n, nf.id)) : undefined;
      activity.push({ at, type: "NOTE", kind: "note", text, actor, fp: fingerprint(recordId, "note", id ?? "", at.toISOString(), actor) });
    }
  }

  let meetings: CrmMeeting[] = [];
  if (map.meetings) {
    const listed = await client.list(map.meetings, { recordId }, 5);
    meetings = listed.items.map((m) => meetingOf(m, map)).filter((m): m is CrmMeeting => Boolean(m));
    for (const m of meetings) {
      // The booking is already an event. What only the meeting list knows is what was said,
      // so that is the row it adds — once the CRM has a summary to give.
      if (!m.summary && !m.actionItems?.length) continue;
      activity.push({
        at: m.end ?? m.start ?? new Date(),
        type: "MEETING_SUMMARY",
        kind: "meeting_held",
        text: m.summary,
        actor: m.organizer,
        meta: { title: m.title, actionItems: m.actionItems, nextSteps: m.nextSteps },
        // Keyed on the meeting, not its words, so a summary the CRM finishes later replaces
        // the first draft rather than sitting beside it.
        fp: fingerprint(recordId, "meeting", m.title, m.start?.toISOString()),
      });
    }
  }

  const added = await storeActivity(client, recordId, personId, activity);
  const lastActivityAt = activity.reduce<Date | undefined>((max, r) => (!max || r.at > max ? r.at : max), undefined);
  await links.updateOne(
    { orgId, connectionId, externalId: recordId },
    {
      $set: {
        productId,
        personId,
        status: verdict.status,
        matchedBy: verdict.matchedBy,
        why: verdict.why,
        snapshot: snap,
        meetings,
        ...(lastActivityAt ? { lastActivityAt } : {}),
        historyTruncated: events.more,
        syncedAt: new Date(),
        checkedAt: new Date(),
      },
      $setOnInsert: { linkedAt: new Date() },
    },
    { upsert: true },
  );
  // Rows stored before the record was tied to a person get their person now.
  if (personId) {
    await db
      .collection(C.crmActivity)
      .updateMany({ orgId, connectionId, recordId, personId: { $ne: personId } }, { $set: { personId } });
  }
  return { status: verdict.status, personId, added };
}

/**
 * Looks one of our people up in the CRM and pulls in whatever it holds on them.
 * The person is marked checked either way, so the backfill does not ask again.
 */
export async function syncPerson(client: CrmClient, personId: string): Promise<{ records: number; added: number }> {
  const db = await getDb();
  const { orgId, productId, connectionId, map } = client.conn;
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId), orgId, productId });
  if (!person) return { records: 0, added: 0 };

  const ids = (person.identities ?? []) as Array<{ kind: string; value: string }>;
  const email = lowerEmail(ids.find((i) => i.kind === "email")?.value ?? person.primaryEmail);
  const phone = phoneKey(ids.find((i) => i.kind === "phone")?.value);
  const idPath = map.fields.id;

  const found = new Map<string, Row>();
  if (email) {
    const hits = await client.list(map.findByEmail, { email }, 2);
    for (const r of hits.items) {
      if (lowerEmail(pluck(r, map.fields.email ?? "email")) === email) found.set(String(pluck(r, idPath)), r);
    }
  }
  if (phone && map.findByPhone) {
    const hits = await client.list(map.findByPhone, { phone }, 2);
    for (const r of hits.items) {
      if (phoneKey(pluck(r, map.fields.phone ?? "phone")) === phone) found.set(String(pluck(r, idPath)), r);
    }
  }

  let added = 0;
  let records = 0;
  for (const [recordId, row] of found) {
    if (!recordId || recordId === "undefined") continue;
    const res = await syncRecord(client, recordId, { personId: email && lowerEmail(pluck(row, map.fields.email ?? "email")) === email ? personId : undefined, row });
    if (res.personId === personId) records++;
    added += res.added;
  }
  await db
    .collection(C.people)
    .updateOne({ _id: person._id }, { $set: { [`crmChecked.${connectionId}`]: new Date() } });
  return { records, added };
}

/**
 * Reads what changed in the CRM since the last poll and refreshes every record it touched
 * that is — or might be — one of ours.
 *
 * Records already known to belong elsewhere cost nothing: a Grow8 deal in a shared CRM is
 * remembered as out of scope and its events are skipped without a call.
 */
export async function syncChanges(client: CrmClient, until: number): Promise<{ events: number; records: number; more: boolean }> {
  const db = await getDb();
  const { orgId, connectionId, map } = client.conn;
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  const sync = (connection?.crm?.sync ?? {}) as { cursor?: string; pending?: string[] };
  const since = dateOf(sync.cursor) ?? new Date(Date.now() - FEED_OVERLAP_MS);
  const fromAt = new Date(since.getTime() - (map.fromFormat === "date" ? FEED_OVERLAP_MS : 0));
  const from = map.fromFormat === "date" ? fromAt.toISOString().slice(0, 10) : fromAt.toISOString();

  const pending = new Set<string>(sync.pending ?? []);
  let newest = since;
  let events = 0;
  const feed = await client.list(map.changes, { from }, 10);
  for (const e of feed.items) {
    const at = dateOf(pluck(e, map.eventFields.at));
    const recordId = str(pluck(e, map.eventFields.recordId));
    if (!at || !recordId || at <= since) continue;
    events++;
    if (at > newest) newest = at;
    pending.add(recordId);
  }

  // The feed is cheap and the records are not, so what the feed names is queued and worked
  // off over as many ticks as it takes, rather than all inside one.
  let records = 0;
  const links = db.collection(C.crmLinks);
  for (const recordId of [...pending]) {
    if (Date.now() > until) break;
    const link = await links.findOne({ orgId, connectionId, externalId: recordId });
    pending.delete(recordId);
    if (link?.status === "out_of_scope") continue;
    if (link?.status === "unmatched" && link.checkedAt && Date.now() - new Date(link.checkedAt).getTime() < UNMATCHED_RECHECK_MS) continue;
    try {
      await syncRecord(client, recordId, link?.personId ? { personId: String(link.personId) } : undefined);
      records++;
    } catch (err) {
      if (err instanceof RateLimited) {
        pending.add(recordId);
        throw err;
      }
      // One record the CRM cannot answer for must not hold up every record behind it.
      await links.updateOne(
        { orgId, connectionId, externalId: recordId },
        { $set: { lastError: err instanceof Error ? err.message.slice(0, 300) : String(err), checkedAt: new Date() }, $setOnInsert: { status: "unmatched", productId: client.conn.productId } },
        { upsert: true },
      );
    }
  }

  await db.collection(C.connections).updateOne(
    { _id: new ObjectId(connectionId) },
    { $set: { "crm.sync.cursor": newest.toISOString(), "crm.sync.pending": [...pending].slice(0, 500) } },
  );
  return { events, records, more: pending.size > 0 || feed.more };
}

/** People in this product nobody has looked up yet, the chosen campaign's first. */
async function unchecked(
  orgId: string,
  productId: string,
  connectionId: string,
  goalKey: string | undefined,
  limit: number,
  onlyGoal: boolean,
) {
  const db = await getDb();
  const filter = { orgId, productId, [`crmChecked.${connectionId}`]: { $exists: false } };
  if (goalKey) {
    const ids = await db
      .collection(C.goalInstances)
      .find({ orgId, productId, goalKey })
      .project({ personId: 1 })
      .toArray();
    const inGoal = ids.map((g) => String(g.personId)).filter((id) => ObjectId.isValid(id));
    const first = await db
      .collection(C.people)
      .find({ ...filter, _id: { $in: inGoal.map((id) => new ObjectId(id)) } })
      .project({ _id: 1 })
      .limit(limit)
      .toArray();
    if (first.length || onlyGoal) return first.map((p) => String(p._id));
  }
  const rest = await db.collection(C.people).find(filter).project({ _id: 1 }).sort({ createdAt: -1 }).limit(limit).toArray();
  return rest.map((p) => String(p._id));
}

export async function checkUnchecked(
  client: CrmClient,
  until: number,
  goalKey?: string,
  onlyGoal = false,
): Promise<number> {
  const { orgId, productId, connectionId } = client.conn;
  const db = await getDb();
  let done = 0;
  // A person takes a handful of spaced calls. Starting one with less room than that would
  // run past the deadline the tick gave us, and the tick's deadline is the platform's.
  while (until - Date.now() > PERSON_ROOM_MS) {
    const batch = await unchecked(orgId, productId, connectionId, goalKey, 5, onlyGoal);
    if (!batch.length) break;
    for (const personId of batch) {
      if (until - Date.now() <= PERSON_ROOM_MS) break;
      try {
        await syncPerson(client, personId);
      } catch (err) {
        if (err instanceof RateLimited) throw err;
        // Marked checked with the reason, so one lookup the CRM chokes on is not retried on
        // every tick forever while everybody behind it waits.
        await db.collection(C.people).updateOne(
          { _id: new ObjectId(personId) },
          {
            $set: {
              [`crmChecked.${connectionId}`]: new Date(),
              [`crmCheckError.${connectionId}`]: err instanceof Error ? err.message.slice(0, 300) : String(err),
            },
          },
        );
      }
      done++;
    }
  }
  return done;
}

/**
 * One runner per connection at a time. The tick, a second shard and a backfill run from a
 * laptop would otherwise read the same feed at once — harmless to the data, which is
 * fingerprinted, but three times the calls against a rate limit the connection shares.
 */
export async function lockConnection(connectionId: string, ms: number): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const res = await db.collection(C.connections).updateOne(
    {
      _id: new ObjectId(connectionId),
      $or: [{ "crm.sync.lockedUntil": { $exists: false } }, { "crm.sync.lockedUntil": { $lt: now } }],
    },
    { $set: { "crm.sync.lockedUntil": new Date(now.getTime() + ms) } },
  );
  return res.modifiedCount === 1;
}

export async function unlockConnection(connectionId: string): Promise<void> {
  const db = await getDb();
  await db.collection(C.connections).updateOne({ _id: new ObjectId(connectionId) }, { $unset: { "crm.sync.lockedUntil": "" } });
}

/**
 * The CRM step of the minute tick. Runs after sending, on a capped slice of the budget,
 * and only for connections a person switched CRM reading on for. With none, it reads one
 * empty query and returns — the engine behaves exactly as it did before CRM reading existed.
 */
export async function crmTick(deadline: number, productIds: string[]): Promise<Array<Record<string, unknown>>> {
  const db = await getDb();
  const report: Array<Record<string, unknown>> = [];
  const connections = await db
    .collection(C.connections)
    .find({ "crm.enabled": true, productId: { $in: productIds } })
    .project({ _id: 1, orgId: 1, productId: 1, crm: 1 })
    .toArray();

  for (const connection of connections) {
    if (Date.now() > deadline) break;
    const connectionId = String(connection._id);
    const sync = (connection.crm?.sync ?? {}) as { lastPollAt?: Date; rateLimitedUntil?: Date; backfillGoal?: string };
    if (sync.rateLimitedUntil && new Date(sync.rateLimitedUntil).getTime() > Date.now()) continue;
    if (!(await lockConnection(connectionId, 90_000))) continue;

    const set: Record<string, unknown> = { "crm.sync.lastRunAt": new Date() };
    try {
      const client = await CrmClient.open(connectionId);
      const due = !sync.lastPollAt || Date.now() - new Date(sync.lastPollAt).getTime() >= POLL_EVERY_MS;
      const changes = due ? await syncChanges(client, deadline) : null;
      if (due) set["crm.sync.lastPollAt"] = new Date();
      const checked = await checkUnchecked(client, deadline, sync.backfillGoal);
      set["crm.sync.status"] = "ok";
      set["crm.sync.error"] = null;
      if (changes || checked) report.push({ crm: connectionId, ...(changes ?? {}), checked, calls: client.calls });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set["crm.sync.status"] = err instanceof RateLimited ? "rate_limited" : "error";
      set["crm.sync.error"] = message.slice(0, 300);
      if (err instanceof RateLimited) set["crm.sync.rateLimitedUntil"] = new Date(Date.now() + 5 * 60_000);
      report.push({ crm: connectionId, error: message.slice(0, 200) });
    } finally {
      await db
        .collection(C.connections)
        .updateOne({ _id: connection._id }, { $set: set, $unset: { "crm.sync.lockedUntil": "" } });
    }
  }
  return report;
}
