import type { ReactNode } from "react";
import {
  Bell,
  Briefcase,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CircleX,
  GitBranch,
  Info,
  MailOpen,
  Pencil,
  Phone,
  PhoneOff,
  Reply,
  RefreshCw,
  RotateCcw,
  StickyNote,
  Trash2,
  Trophy,
  UserCog,
  UserPlus,
} from "lucide-react";
import type { CrmActivityView, CrmPersonView } from "@/engine/crm/view.js";
import { QUIET_KINDS } from "@/engine/crm/view.js";
import type { CrmKind } from "@/schemas/crm.js";
import { ActionButton } from "../../../../ui/kit";
import { ist, istLong, istTime, istWeekday } from "../../../../ui/time";
import { syncPersonFromCrm } from "../../../../crm-actions";

/**
 * The sales team's side of a person, rendered from our own copy of their CRM.
 *
 * Nothing on this page waits on the CRM: the copy is read, and its age is shown. The
 * section is absent for a product with no CRM switched on, so for everyone else the page
 * is exactly what it was.
 */

const KIND: Record<CrmKind, { label: string; icon: ReactNode; mark?: "signal" | "bad" }> = {
  created: { label: "Added to the sales team's CRM", icon: <UserPlus size={13} /> },
  owner: { label: "Assigned to a rep", icon: <UserCog size={13} /> },
  stage: { label: "Moved in the pipeline", icon: <GitBranch size={13} /> },
  status: { label: "Status changed", icon: <GitBranch size={13} /> },
  won: { label: "The sales team marked it won", icon: <Trophy size={13} />, mark: "signal" },
  lost: { label: "The sales team marked it lost", icon: <CircleX size={13} />, mark: "bad" },
  reopened: { label: "Reopened", icon: <RotateCcw size={13} /> },
  note: { label: "Rep's note", icon: <StickyNote size={13} /> },
  call: { label: "Rep's call", icon: <Phone size={13} /> },
  call_missed: { label: "Rep's call did not connect", icon: <PhoneOff size={13} /> },
  meeting_booked: { label: "Meeting booked", icon: <CalendarCheck size={13} />, mark: "signal" },
  meeting_canceled: { label: "Meeting cancelled", icon: <CalendarX size={13} />, mark: "bad" },
  meeting_held: { label: "Meeting notes", icon: <CalendarClock size={13} />, mark: "signal" },
  email_in: { label: "They emailed the rep", icon: <MailOpen size={13} />, mark: "signal" },
  email_out: { label: "The rep emailed them", icon: <Reply size={13} /> },
  followup: { label: "Follow-up", icon: <Bell size={13} /> },
  deleted: { label: "Removed from the CRM", icon: <Trash2 size={13} />, mark: "bad" },
  field: { label: "Record edited", icon: <Pencil size={13} /> },
  info: { label: "CRM event", icon: <Info size={13} /> },
};

export interface CrmEntry {
  at: Date;
  mark?: "signal" | "bad";
  lane: "sales";
  node: ReactNode;
}

/** One timeline entry per thing the CRM logged, in the page's own entry shape. */
export function crmEntries(view: CrmPersonView): CrmEntry[] {
  const meetings = view.records.flatMap((r) => r.meetings);
  const lostReason = view.records.map((r) => r.snapshot.lostReason).find(Boolean);
  return view.activity.map((a) => ({
    at: a.at,
    lane: "sales",
    mark: KIND[a.kind]?.mark,
    node: <CrmLine a={a} meeting={meetingFor(a, meetings)} lostReason={a.kind === "lost" ? lostReason : undefined} />,
  }));
}

function meetingFor(a: CrmActivityView, meetings: CrmPersonView["records"][number]["meetings"]) {
  if (a.kind !== "meeting_booked" || !a.text) return undefined;
  return meetings.find((m) => a.text?.includes(m.title));
}

function CrmLine({
  a,
  meeting,
  lostReason,
}: {
  a: CrmActivityView;
  meeting?: { title: string; start?: Date; status?: string };
  lostReason?: string;
}) {
  const kind = KIND[a.kind] ?? KIND.info;
  const quiet = QUIET_KINDS.has(a.kind);
  const detail = [a.kind === "note" ? null : a.text, a.actor ? `by ${a.actor}` : null].filter(Boolean).join(" · ");
  const items = Array.isArray(a.meta?.actionItems) ? (a.meta.actionItems as string[]) : [];
  return (
    <>
      <div className="t-line">
        <strong className={quiet ? "muted" : a.kind === "won" || a.kind === "meeting_booked" ? "hit" : undefined}>
          {kind.icon} {kind.label}
        </strong>
        <span className="pill">sales team</span>
        {a.review ? <span className="pill warm">match not confirmed</span> : null}
      </div>
      {a.kind === "note" && a.text ? <blockquote className="t-quote">{a.text}</blockquote> : null}
      {detail ? <div className="muted t-detail">{detail}</div> : null}
      {meeting?.start ? (
        <div className="muted t-detail" title={istLong(meeting.start)}>
          For {istWeekday(meeting.start)} at {istTime(meeting.start)}
          {meeting.status ? ` · ${meeting.status}` : ""}
        </div>
      ) : null}
      {lostReason ? <div className="muted t-detail">Reason: {lostReason}</div> : null}
      {items.length ? <div className="muted t-detail">Action items: {items.join(" · ")}</div> : null}
    </>
  );
}

/** Where the person stands with the sales team, and a way to read it again now. */
export function SalesTeamCard({ view, productId, personId }: { view: CrmPersonView; productId: string; personId: string }) {
  if (!view.enabled && view.records.length === 0) return null;
  const sync = (
    <ActionButton
      action={syncPersonFromCrm.bind(null, productId, personId)}
      variant="ghost"
      size="sm"
      icon={<RefreshCw />}
      pendingLabel="Reading the CRM…"
      toast={{ title: "Read from the CRM", body: "Anything new is on the timeline." }}
    >
      Read from CRM now
    </ActionButton>
  );

  if (view.records.length === 0) {
    return (
      <>
        <h2>Sales team</h2>
        <div className="card crm-card">
          <div className="crm-head">
            <Briefcase size={15} />
            <strong>Not in the sales team's CRM</strong>
            <div className="spacer" />
            {view.enabled ? sync : null}
          </div>
          <p className="sub crm-sub">
            {view.checkedAt
              ? `Looked up by email and phone ${ist(view.checkedAt)}. If the team adds them later, it shows here within ten minutes.`
              : "Not looked up yet. The engine checks new people within a few minutes."}
          </p>
        </div>
      </>
    );
  }

  const now = Date.now();
  return (
    <>
      <h2>Sales team</h2>
      <p className="sub">From the sales team's CRM, read-only. It adds to this page and changes nothing about what we send.</p>
      {view.records.map((r) => {
        const s = r.snapshot;
        const next = r.meetings
          .filter((m) => m.start && new Date(m.start).getTime() > now && !/cancel/i.test(m.status ?? ""))
          .sort((a, b) => new Date(a.start as Date).getTime() - new Date(b.start as Date).getTime())[0];
        const last = r.meetings
          .filter((m) => m.start && new Date(m.start).getTime() <= now)
          .sort((a, b) => new Date(b.start as Date).getTime() - new Date(a.start as Date).getTime())[0];
        return (
          <div className="card crm-card" key={r.externalId}>
            <div className="crm-head">
              <Briefcase size={15} />
              <strong>{s.name ?? "CRM record"}</strong>
              {s.status ? (
                <span className={`pill ${s.status === "won" ? "ok" : s.status === "lost" ? "bad" : s.status === "hot" ? "hot" : s.status === "warm" ? "warm" : ""}`}>
                  {s.status}
                </span>
              ) : null}
              {s.stage ? <span className="pill">{s.stage}</span> : null}
              {r.status === "review" ? <span className="pill warm">match not confirmed</span> : null}
              <div className="spacer" />
              {view.enabled ? sync : null}
            </div>
            <dl className="crm-facts">
              {s.owner ? (<><dt>Rep</dt><dd>{s.owner}</dd></>) : null}
              {s.source ? (<><dt>Came from</dt><dd>{s.source}</dd></>) : null}
              {typeof s.value === "number" ? (<><dt>Value</dt><dd>{s.value} {s.currency ?? ""}</dd></>) : null}
              {s.createdAt ? (<><dt>In the CRM since</dt><dd title={istLong(s.createdAt)}>{ist(s.createdAt)}</dd></>) : null}
              {r.lastActivityAt ? (<><dt>Last team activity</dt><dd title={istLong(r.lastActivityAt)}>{ist(r.lastActivityAt)}</dd></>) : null}
              {next?.start ? (
                <><dt>Next meeting</dt><dd title={istLong(next.start)}>{next.title} · {istWeekday(next.start)} {istTime(next.start)}</dd></>
              ) : last?.start ? (
                <><dt>Last meeting</dt><dd title={istLong(last.start)}>{last.title} · {istWeekday(last.start)} {istTime(last.start)}{last.status ? ` · ${last.status}` : ""}</dd></>
              ) : null}
              {s.wonAt ? (<><dt>Won</dt><dd>{ist(s.wonAt)}</dd></>) : null}
              {s.lostAt ? (<><dt>Lost</dt><dd>{ist(s.lostAt)}{s.lostReason ? ` · ${s.lostReason}` : ""}</dd></>) : null}
            </dl>
            <p className="sub crm-sub">
              Matched by {r.matchedBy === "email+phone" ? "email and phone" : r.matchedBy ?? "hand"}
              {r.why ? ` — not confirmed: ${r.why}` : ""}. Read {ist(r.syncedAt)}.
            </p>
          </div>
        );
      })}
    </>
  );
}
