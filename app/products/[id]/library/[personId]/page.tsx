import { personHistory } from "@/engine/library.js";
import { suppressPerson } from "../../../../actions";
import { requireSession } from "../../../../tenant";
import ConfirmButton from "../../../../ui/confirm";
import ClaudeBadge from "../../../../ui/claude-badge";

export const dynamic = "force-dynamic";

const when = (value: unknown) =>
  value ? new Date(String(value)).toISOString().replace("T", " ").slice(0, 16) : "—";

/**
 * One human, everything. Past above the line, scheduled below it, in a single column —
 * splitting them into "history" and "upcoming" forces the reader to reassemble the story
 * this page exists to tell.
 */
export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string; personId: string }>;
}) {
  const { id, personId } = await params;
  const { orgId } = await requireSession();
  const history = await personHistory(orgId, id, personId);
  if (!history) return <main><h1>Not found</h1></main>;

  const { person, campaigns, actions, plans, events } = history;
  const belief = person.belief as
    | { segment: string; confidence: number; painHypothesis?: string; objectionsLikely?: string[]; reasoning?: string }
    | undefined;
  const temp = person.temp as { band: string; score: number } | undefined;
  const inv = (person.investment ?? {}) as Record<string, number>;
  const arrivals = (person.arrivals ?? []) as Array<{ kind: string; at: string; detail?: string }>;
  const objections = (person.objections ?? []) as Array<{ text: string; at: string; source: string }>;

  const now = Date.now();
  const sent = actions.filter((a) => a.status === "sent" || a.status === "dispatched");
  const upcoming = actions.filter((a) => ["queued", "awaiting_approval"].includes(String(a.status)));

  return (
    <>
      <div className="head">
        <div>
          <h1>{String(person.name ?? person.primaryEmail)}</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {String(person.primaryEmail ?? "")}
            {person.role ? ` · ${String(person.role)}` : ""}
            {person.companyDomain ? ` · ${String(person.companyDomain)}` : ""}
            {person.timezone ? ` · ${String(person.timezone)}` : ""}
          </p>
        </div>
        <div className="spacer" />
        <div className="row">
          <span className={`pill ${person.lifecycle === "suppressed" ? "bad" : person.lifecycle === "active" ? "ok" : ""}`}>
            {String(person.lifecycle ?? "new")}
          </span>
          {temp && <span className={`pill ${temp.band}`}>{temp.band} {Math.round(temp.score)}</span>}
          {person.lifecycle !== "suppressed" && (
            <ConfirmButton
              label="Never contact"
              title="Never contact this person again?"
              body="Any campaign they are in stops, anything queued is cancelled, and no future import or audience can pick them up. This cannot be undone from here."
              confirmLabel="Suppress permanently"
              action={suppressPerson.bind(null, id, personId)}
            />
          )}
        </div>
      </div>

      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card stat"><div className="label">Attempts</div><div className="value">{Number(person.attempts ?? 0)}</div></div>
        <div className="card stat"><div className="label">Messages</div><div className="value">{Number(inv.messages ?? 0)}</div></div>
        <div className="card stat"><div className="label">Invested</div><div className="value">${Number(inv.usd ?? 0).toFixed(2)}</div></div>
        <div className="card stat"><div className="label">Campaigns</div><div className="value">{campaigns.length}</div></div>
      </div>

      <h2>What we think</h2>
      {belief ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>{belief.segment}</strong>
            <span className="muted">{Math.round(belief.confidence * 100)}% confident</span>
          </div>
          {belief.painHypothesis && <p style={{ marginBottom: 6 }}>{belief.painHypothesis}</p>}
          {belief.objectionsLikely?.length ? (
            <p className="sub" style={{ margin: 0 }}>Expected objections: {belief.objectionsLikely.join(" · ")}</p>
          ) : null}
          {belief.reasoning && <p className="sub" style={{ margin: "6px 0 0" }}>{belief.reasoning}</p>}
        </div>
      ) : (
        <p className="sub"><ClaudeBadge note="not yet classified" /> They get a segment on the next routine run.</p>
      )}

      {objections.length > 0 && (
        <>
          <h2>What they have told us</h2>
          <p className="sub">Carried across every campaign, so a later attempt opens on what they actually said.</p>
          <div className="tw">
            <table>
              <tbody>
                {objections.map((o, i) => (
                  <tr key={i}>
                    <td>{o.text}</td>
                    <td className="muted num">{when(o.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Campaigns</h2>
      {campaigns.length === 0 ? (
        <div className="empty"><strong>Never been in one</strong>They are in the library, waiting.</div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr><th>Campaign</th><th>Started</th><th>Checks</th><th>Verified</th><th>Spent</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const spent = c.spent as { touches: number; usd: number };
                return (
                  <tr key={String(c._id)}>
                    <td><code>{String(c.goalKey)}</code></td>
                    <td className="muted num">{when(c.startedAt)}</td>
                    <td>
                      {Object.keys((c.checkResults ?? {}) as Record<string, boolean>).length === 0 ? (
                        <span className="muted">not checked yet</span>
                      ) : (
                        Object.entries((c.checkResults ?? {}) as Record<string, boolean>).map(([key, passed]) => (
                          <div key={key}>
                            <span className={`pill ${passed ? "ok" : ""}`}>{passed ? "✓" : "·"} {key}</span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="muted num">
                      {when(c.lastVerifiedAt)}
                      {c.status === "active" && c.nextVerifyAt ? (
                        <div style={{ fontSize: 12 }}>next {when(c.nextVerifyAt)}</div>
                      ) : null}
                    </td>
                    <td className="num">{spent?.touches ?? 0} msg</td>
                    <td>
                      <span className={`pill ${c.status === "succeeded" ? "ok" : c.status === "active" ? "" : "bad"}`}>
                        {String(c.status)}
                      </span>
                      {c.outcome ? <div className="muted" style={{ fontSize: 12.5 }}>{String(c.outcome)}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Timeline</h2>
      <p className="sub">Everything done, then everything scheduled. Nothing here is ever overwritten.</p>
      <div className="timeline">
        {arrivals.map((a, i) => (
          <div key={`arr-${i}`}>
            <span className="t-when">{when(a.at)}</span>
            <span className="t-mark" />
            <span>
              <strong>Arrived</strong> <span className="muted">via {a.kind}{a.detail ? ` · ${a.detail}` : ""}</span>
            </span>
          </div>
        ))}

        {sent.map((a) => {
          const content = a.content as { subject?: string } | undefined;
          const outcome = a.outcome as { grade?: string } | undefined;
          return (
            <div key={String(a._id)}>
              <span className="t-when">{when(a.sentAt ?? a.dueAt)}</span>
              <span className="t-mark" />
              <span>
                <strong>{content?.subject ?? `Message on ${String(a.channel)}`}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  angle {String(a.angle)} · {String(a.status)}
                  {outcome?.grade ? ` · graded ${outcome.grade}` : ""}
                </div>
                {a.rationale ? <div className="muted" style={{ fontSize: 12.5 }}>Why: {String(a.rationale)}</div> : null}
              </span>
            </div>
          );
        })}

        {events.map((e) => (
          <div key={String(e._id)}>
            <span className="t-when">{when(e.ts)}</span>
            <span className="t-mark signal" />
            <span><strong>{String(e.type)}</strong></span>
          </div>
        ))}

        {upcoming.map((a) => {
          const content = a.content as { subject?: string } | undefined;
          const due = new Date(String(a.dueAt)).getTime();
          return (
            <div key={String(a._id)} className="future">
              <span className="t-when">{when(a.dueAt)}</span>
              <span className="t-mark next" />
              <span>
                <strong>{content?.subject ?? `Message on ${String(a.channel)}`}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {a.status === "awaiting_approval" ? "waiting for your review" : due > now ? "scheduled" : "due now"}
                  {" · "}angle {String(a.angle)}
                </div>
              </span>
            </div>
          );
        })}

        {sent.length === 0 && upcoming.length === 0 && arrivals.length === 0 && (
          <p className="sub">Nothing yet.</p>
        )}
      </div>

      {plans.length > 0 && (
        <>
          <h2>Plans</h2>
          <p className="sub">
            Every version is kept. A replan writes a new one and says why the previous was abandoned, so a
            message sent months ago still has its reasoning attached.
          </p>
          {plans.map((plan) => (
            <div className="card" key={String(plan._id)} style={{ marginBottom: 12 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="label" style={{ margin: 0 }}>version {String(plan.version)}</span>
                <ClaudeBadge />
                <span className="muted" style={{ fontSize: 12.5 }}>{when(plan.createdAt)}</span>
              </div>
              <p style={{ marginBottom: 8 }}>{String(plan.rationale)}</p>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5 }}>
                {(plan.steps as Array<Record<string, unknown>>).map((step, i) => (
                  <li key={i}>
                    <strong>{String(step.angle)}</strong> on {String(step.channel)}, day {String(step.after_days ?? step.afterDays ?? "?")}
                    <div className="muted">{String(step.why ?? "")}</div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </>
      )}
    </>
  );
}
