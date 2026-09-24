import { ObjectId, type Document } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { claim, complete, enqueue, fail, orgsWithWork } from "../queue.js";
import { CrmClient } from "./client.js";

/**
 * Our side of a lead, written into the sales team's CRM as notes.
 *
 * The sync has always been one-way: they could see every call their own team made and
 * nothing we did, so a rep phoned a lead who had opened three of our emails that week
 * without knowing it, and another was written off the same day he clicked the sign-up page.
 * Neither of them could have known. Nothing we do reached the place they look.
 *
 * What gets written is narrow on purpose: what was sent, what a person opened, what they
 * clicked, what they wrote back. Never a plan, never a failure, never a message that did not
 * reach anybody. A rep opening a lead should find a short list of things that actually
 * happened — the moment it becomes a log of our internal machinery, they stop reading it,
 * and the useful three lines go unread with the rest.
 *
 * Everything here is queued rather than called inline. Their CRM shares one rate limit with
 * their production traffic, and a send that waits on a CRM write is a send that fails when
 * the CRM is down.
 */

/** The events worth a rep's attention. Anything not in this list is not written, ever. */
export const NOTE_EVENTS = ["email_sent", "whatsapp_sent", "linkedin_sent", "opened", "clicked", "replied"] as const;
export type NoteEvent = (typeof NOTE_EVENTS)[number];

/** Their feed truncates around sixty characters and our prefix spends thirteen of them. */
const SUBJECT_MAX = 45;

/** Long enough to place a message, short enough that the row still reads as one line. */
export function shorten(text: string | undefined, max = SUBJECT_MAX): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export interface CrmWriteConfig {
  enabled: boolean;
  events: Set<string>;
  actorUserId?: string;
}

/** What this connection is allowed to write, and as whom. Off unless somebody turned it on. */
export function writeConfigOf(connection: Document | null | undefined): CrmWriteConfig {
  const write = (connection?.crm?.write ?? {}) as { enabled?: boolean; events?: string[]; actorUserId?: string };
  return {
    enabled: write.enabled === true,
    events: new Set(write.events?.length ? write.events : NOTE_EVENTS),
    actorUserId: write.actorUserId,
  };
}

/**
 * Remembers a note to write, if this product writes notes at all.
 *
 * `key` is what makes the event unique — an action id, or a person and a day for something
 * that has no message behind it. The queue keeps one pending item per subject per kind, so
 * the same event queued twice is one note, and a tick that runs twice writes nothing extra.
 */
export async function noteEvent(input: {
  orgId: string;
  productId: string;
  personId: string;
  event: NoteEvent;
  body: string;
  key: string;
  campaignKey?: string;
}): Promise<boolean> {
  const db = await getDb();
  const connection = await db
    .collection(C.connections)
    .findOne({ orgId: input.orgId, productId: input.productId, "crm.enabled": true });
  const config = writeConfigOf(connection);
  if (!config.enabled || !config.events.has(input.event)) return false;

  // A person their CRM has never heard of has nowhere to write to. Checked here rather than
  // at the drain so the queue does not fill with work that can never be done.
  const link = await db
    .collection(C.crmLinks)
    .findOne({ orgId: input.orgId, productId: input.productId, personId: input.personId, status: "linked" });
  if (!link?.externalId) return false;

  await enqueue(
    input.orgId,
    "crm_note",
    { personId: input.personId, recordId: String(link.externalId), body: input.body, event: input.event, connectionId: String(connection!._id) },
    { productId: input.productId, campaignKey: input.campaignKey, subjectId: `${input.key}:${input.event}` },
  );
  return true;
}

export interface DrainSummary {
  written: number;
  failed: number;
}

/**
 * Writes the notes that are waiting, inside whatever time the CRM cron has left.
 *
 * A write that fails is left to the queue: it retries on the next run and retires itself
 * after five attempts, so a CRM that is down for an hour costs a delay rather than a hole in
 * the record. A write that succeeds is completed at once — the one thing never worth
 * retrying is a note that might already be there.
 *
 * Nothing here sleeps between calls: the client already holds every call on this connection
 * three seconds apart, reads and writes alike, so a wait added here would only double it.
 */
export async function drainNotes(deadline: number): Promise<DrainSummary> {
  const summary: DrainSummary = { written: 0, failed: 0 };
  const clients = new Map<string, CrmClient>();

  for (const orgId of await orgsWithWork("crm_note")) {
    while (Date.now() < deadline) {
      const job = await claim<{ personId: string; recordId: string; body: string; event: string; connectionId: string }>(orgId, "crm_note");
      if (!job) break;

      try {
        const connectionId = job.payload.connectionId;
        if (!clients.has(connectionId)) clients.set(connectionId, await CrmClient.open(connectionId));
        const client = clients.get(connectionId)!;
        const write = client.conn.map.write;
        const spec = write?.note;
        if (!spec) throw new Error("this connection has no note-writing tool mapped");

        const db = await getDb();
        const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
        const config = writeConfigOf(connection);
        const args = { ...spec.args, ...(write.actorArg && config.actorUserId ? { [write.actorArg]: config.actorUserId } : {}) };

        const result = await client.call(spec.tool, args, { recordId: job.payload.recordId, body: job.payload.body });
        await complete(job._id);
        summary.written++;
        await learnActor(connectionId, result);
      } catch (err) {
        await fail(job._id, err instanceof Error ? err.message : String(err));
        summary.failed++;
      }
    }
  }
  return summary;
}

/**
 * Records which actor the CRM logged our write under, so the sync can ignore it.
 *
 * Read from the write's own reply rather than configured, because the CRM is the only thing
 * that knows: our key resolves to a user we never named, and it prints that user's display
 * name on the lead page and in the feed we read back. A value nobody has to type is a value
 * nobody can get wrong, and getting it wrong here means every note we write re-plans the
 * message that wrote it.
 */
async function learnActor(connectionId: string, result: unknown): Promise<void> {
  const actor = (result as { actor?: { userId?: string; email?: string; name?: string } } | undefined)?.actor;
  const names = [actor?.userId, actor?.email, actor?.name].filter((v): v is string => Boolean(v));
  if (!names.length) return;

  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) }, { projection: { "crm.map.ours": 1 } });
  const known = new Set(((connection?.crm?.map?.ours ?? []) as string[]).map((n) => n.trim().toLowerCase()));
  const missing = names.filter((n) => !known.has(n.trim().toLowerCase()));
  if (!missing.length) return;

  await db
    .collection(C.connections)
    .updateOne({ _id: new ObjectId(connectionId) }, { $addToSet: { "crm.map.ours": { $each: missing } } });
}
