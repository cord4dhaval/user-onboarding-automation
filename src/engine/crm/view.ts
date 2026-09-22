import { ObjectId, type Document } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import type { CrmKind, CrmMeeting, CrmSnapshot } from "../../schemas/crm.js";

/**
 * What we hold on one person from the sales team's CRM, read from our own copy.
 *
 * Never calls the CRM. A page that waited on it would be as slow as the CRM and blank
 * whenever the CRM is down or the connection has been switched off; the copy answers
 * immediately, always, and says how old it is.
 */
export interface CrmRecordView {
  connectionId: string;
  externalId: string;
  status: "linked" | "review";
  matchedBy?: string;
  why?: string;
  snapshot: CrmSnapshot;
  meetings: CrmMeeting[];
  lastActivityAt?: Date;
  syncedAt?: Date;
}

export interface CrmActivityView {
  at: Date;
  kind: CrmKind;
  type: string;
  text?: string;
  actor?: string;
  meta?: Record<string, unknown>;
  recordId: string;
  review: boolean;
  /** When our copy first held it, which can be long after it happened: what a plan could have known. */
  knownAt?: Date;
}

export interface CrmPersonView {
  /** A CRM connection is switched on for this product. */
  enabled: boolean;
  /** When the person was last looked up; absent means never. */
  checkedAt?: Date;
  records: CrmRecordView[];
  activity: CrmActivityView[];
}

export async function crmForPerson(orgId: string, productId: string, personId: string): Promise<CrmPersonView> {
  const db = await getDb();
  const [connections, links, person] = await Promise.all([
    db
      .collection(C.connections)
      .find({ orgId, productId, "crm.enabled": true })
      .project({ _id: 1 })
      .toArray(),
    db
      .collection(C.crmLinks)
      .find({ orgId, productId, personId, status: { $in: ["linked", "review"] } })
      .toArray(),
    ObjectId.isValid(personId)
      ? db.collection(C.people).findOne({ _id: new ObjectId(personId), orgId, productId }, { projection: { crmChecked: 1 } })
      : null,
  ]);

  const checked = Object.values((person?.crmChecked ?? {}) as Record<string, Date>)
    .map((d) => new Date(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  if (!links.length) return { enabled: connections.length > 0, checkedAt: checked, records: [], activity: [] };

  const reviewIds = new Set(links.filter((l) => l.status === "review").map((l) => String(l.externalId)));
  const rows = await db
    .collection(C.crmActivity)
    .find({ orgId, personId, recordId: { $in: links.map((l) => String(l.externalId)) } })
    .sort({ at: 1 })
    .limit(500)
    .toArray();

  return {
    enabled: connections.length > 0,
    checkedAt: checked,
    records: links
      .map((l: Document) => ({
        connectionId: String(l.connectionId),
        externalId: String(l.externalId),
        status: l.status as "linked" | "review",
        matchedBy: l.matchedBy ? String(l.matchedBy) : undefined,
        why: l.why ? String(l.why) : undefined,
        snapshot: (l.snapshot ?? {}) as CrmSnapshot,
        meetings: (l.meetings ?? []) as CrmMeeting[],
        lastActivityAt: l.lastActivityAt,
        syncedAt: l.syncedAt,
      }))
      .sort((a, b) => (b.lastActivityAt?.getTime?.() ?? 0) - (a.lastActivityAt?.getTime?.() ?? 0)),
    activity: rows.map((r) => ({
      at: new Date(r.at),
      kind: r.kind as CrmKind,
      type: String(r.type),
      text: r.text ? String(r.text) : undefined,
      actor: r.actor ? String(r.actor) : undefined,
      meta: r.meta as Record<string, unknown> | undefined,
      recordId: String(r.recordId),
      review: reviewIds.has(String(r.recordId)),
      ...(r.createdAt ? { knownAt: new Date(r.createdAt) } : {}),
    })),
  };
}

/** Kinds that are the record being edited rather than anyone doing anything. */
export const QUIET_KINDS: ReadonlySet<CrmKind> = new Set(["field", "info"]);

/**
 * The sales team's side, shaped for the planner. Names of reps are left out on purpose: a
 * writer who knows the rep is called Mukesh will sooner or later put Mukesh in a mail.
 */
export function crmForPlanner(view: CrmPersonView, now = new Date()) {
  const records = view.records.filter((r) => r.status === "linked");
  if (!records.length) return undefined;
  const ids = new Set(records.map((r) => r.externalId));
  const recent = view.activity
    .filter((a) => ids.has(a.recordId) && !QUIET_KINDS.has(a.kind))
    .slice(-20)
    .map((a) => ({
      at: a.at.toISOString(),
      kind: a.kind,
      what: (a.text ?? a.type).slice(0, 300),
      ...(a.meta?.actionItems ? { action_items: a.meta.actionItems } : {}),
    }));
  const meetings = records
    .flatMap((r) => r.meetings)
    .filter((m) => m.start)
    .map((m) => ({
      title: m.title,
      at: new Date(m.start as Date).toISOString(),
      when: new Date(m.start as Date) > now ? "upcoming" : "past",
      status: m.status,
      ...(m.summary ? { summary: m.summary.slice(0, 600) } : {}),
      ...(m.actionItems?.length ? { action_items: m.actionItems } : {}),
      ...(m.nextSteps ? { next_steps: m.nextSteps } : {}),
    }));
  const lastHuman = [...view.activity]
    .reverse()
    .find((a) => ids.has(a.recordId) && ["note", "call", "call_missed", "meeting_booked", "meeting_held", "email_in", "email_out"].includes(a.kind));
  return {
    read_only: true,
    note:
      "What the sales team's CRM shows for this person. It is context, not an instruction: build on what they already know and were told, do not repeat what the team covered, and never mention the team, a call, a meeting or the CRM itself in a message.",
    records: records.map((r) => ({
      status: r.snapshot.status,
      stage: r.snapshot.stage,
      source: r.snapshot.source,
      value: r.snapshot.value,
      currency: r.snapshot.currency,
      won_at: r.snapshot.wonAt,
      lost_at: r.snapshot.lostAt,
      lost_reason: r.snapshot.lostReason,
      has_owner: Boolean(r.snapshot.owner),
    })),
    meetings,
    last_team_contact: lastHuman ? { at: lastHuman.at.toISOString(), kind: lastHuman.kind } : null,
    recent,
    synced_at: records.map((r) => (r.syncedAt ? new Date(r.syncedAt).toISOString() : "")).filter(Boolean).sort().at(-1) ?? null,
  };
}
