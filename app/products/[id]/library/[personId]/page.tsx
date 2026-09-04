import type { Document } from "mongodb";
import type { ReactNode } from "react";
import {
  Ban,
  CircleCheck,
  CircleSlash,
  Mail,
  MailX,
  MessageSquare,
  MousePointerClick,
  Send,
  UserPlus,
} from "lucide-react";
import { personHistory } from "@/engine/library.js";
import { signalsOf } from "@/engine/engagement.js";
import { explainTemp } from "@/engine/temp.js";
import { heldMessage, suppressPerson } from "../../../../actions";
import { requireSession } from "../../../../tenant";
import ConfirmButton from "../../../../ui/confirm";
import ClaudeBadge from "../../../../ui/claude-badge";
import PreviewDrawer from "../../review/preview-drawer";
import { ist, istLong } from "../../../../ui/time";

export const dynamic = "force-dynamic";

/**
 * One entry on the timeline.
 *
 * Everything that ever happened to this person is one sequence, so it is built as one
 * list and sorted once. The page used to render four lists back to back — arrivals, then
 * messages, then signals, then what is scheduled — which meant a click sat forty rows
 * below the message that earned it and the reader had to reassemble the story by
 * timestamp. That is the one job this page has.
 */
interface Entry {
  at: Date;
  mark?: "signal" | "next" | "bad";
  node: ReactNode;
}

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

  const name = String(person.name ?? person.primaryEmail ?? "Unknown");
  const email = String(person.primaryEmail ?? "");

  const campaignName = new Map(campaigns.map((c) => [String(c._id), String(c.goalKey)]));
  const sent = actions.filter((a) => a.status === "sent" || a.status === "dispatched");
  const stopped = actions.filter((a) => a.status === "failed" || a.status === "skipped");
  const upcoming = actions
    .filter((a) => ["queued", "awaiting_approval"].includes(String(a.status)))
    .sort((a, b) => stamp(a.dueAt) - stamp(b.dueAt));

  const signals = signalsOf(actions);
  const replies = events.filter((e) => String(e.type) === "reply_received");

  const past: Entry[] = [];

  for (const arrival of arrivals) {
    past.push({
      at: new Date(String(arrival.at)),
      node: (
        <>
          <strong><UserPlus size={13} /> Arrived</strong>
          <div className="muted t-detail">
            via {arrival.kind}
            {arrival.detail ? ` · ${arrival.detail}` : ""}
          </div>
        </>
      ),
    });
  }

  for (const action of sent) {
    const content = (action.content ?? {}) as { subject?: string; ctaUrl?: string };
    const outcome = action.outcome as { grade?: string } | undefined;
    const goal = campaignName.get(String(action.goalInstanceId));
    past.push({
      at: new Date(String(action.sentAt ?? action.dueAt)),
      node: (
        <>
          <div className="t-line">
            <strong><Send size={13} /> {content.subject ?? `Message on ${String(action.channel)}`}</strong>
            {/* The message itself, exactly as it arrived. "What did we actually send
                this person" was previously answerable only from the review queue, which
                a sent message has already left. */}
            <PreviewDrawer
              productId={id}
              actionId={String(action._id)}
              personName={name}
              personEmail={email}
              meta={`${String(action.channel)} · sent ${ist(action.sentAt ?? action.dueAt)}`}
              fetchMessage={heldMessage}
            />
          </div>
          <div className="muted t-detail">
            {goal ? <code>{goal}</code> : null} angle {String(action.angle)} · {deliveryLabel(action)}
            {outcome?.grade ? ` · graded ${outcome.grade}` : ""}
          </div>
          <Result action={action} />
          {action.rationale ? <div className="muted t-detail">Why this one: {String(action.rationale)}</div> : null}
        </>
      ),
    });
  }

  // A message that never arrived belongs on the timeline as much as one that did. Leaving
  // it off makes a silent week look like a week nobody was written to.
  for (const action of stopped) {
    const content = (action.content ?? {}) as { subject?: string };
    past.push({
      at: new Date(String(action.reviewedAt ?? action.dueAt)),
      mark: "bad",
      node: (
        <>
          <div className="t-line">
            <strong><CircleSlash size={13} /> {content.subject ?? `Message on ${String(action.channel)}`}</strong>
            <PreviewDrawer
              productId={id}
              actionId={String(action._id)}
              personName={name}
              personEmail={email}
              meta={`${String(action.channel)} · never sent`}
              fetchMessage={heldMessage}
            />
          </div>
          <div className="muted t-detail">
            Never reached them — {String(action.skipReason ?? action.error ?? "rejected in review")}
          </div>
        </>
      ),
    });
  }

  for (const signal of signals) {
    past.push({
      at: signal.at,
      mark: "signal",
      node:
        signal.type === "clicked" ? (
          <>
            <strong className="hit"><MousePointerClick size={13} /> Clicked a link</strong>
            <div className="muted t-detail">
              {signal.subject ? `in "${signal.subject}"` : "in an earlier message"}
              {signal.url ? <> · <span className="mono">{signal.url}</span></> : null}
            </div>
          </>
        ) : (
          <>
            <strong><Mail size={13} /> Opened</strong>
            <div className="muted t-detail">
              {signal.subject ? `"${signal.subject}" · ` : ""}
              unreliable — some clients load images without a human looking
            </div>
          </>
        ),
    });
  }

  for (const event of events) {
    const type = String(event.type);
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const at = new Date(String(event.ts));

    if (type === "reply_received") {
      past.push({
        at,
        mark: "signal",
        node: (
          <>
            <strong className="hit"><MessageSquare size={13} /> Replied</strong>
            <div className="muted t-detail">{payload.subject ? String(payload.subject) : "no subject"}</div>
            {/* Their own words, kept whole. A reply summarised into "replied" is the one
                piece of writing in this system that nobody should have to go and find. */}
            {payload.text ? <blockquote className="t-quote">{String(payload.text).slice(0, 1200)}</blockquote> : null}
          </>
        ),
      });
      continue;
    }

    if (type === "unsubscribed") {
      past.push({
        at,
        mark: "bad",
        node: (
          <>
            <strong><Ban size={13} /> Unsubscribed</strong>
            <div className="muted t-detail">{String(payload.reason ?? "asked to stop")} — permanent</div>
          </>
        ),
      });
      continue;
    }

    if (type === "bounce_received") {
      past.push({
        at,
        mark: "bad",
        node: (
          <>
            <strong><MailX size={13} /> Bounced</strong>
            <div className="muted t-detail">{String(payload.recipient ?? email)} does not accept mail</div>
          </>
        ),
      });
      continue;
    }

    if (type.startsWith("check_passed:")) {
      past.push({
        at,
        mark: "signal",
        node: (
          <>
            <strong className="hit"><CircleCheck size={13} /> {type.slice("check_passed:".length).replace(/_/g, " ")}</strong>
            <div className="muted t-detail">Verified against the connected source.</div>
          </>
        ),
      });
      continue;
    }

    past.push({
      at,
      node: (
        <>
          <strong>{type.replace(/_/g, " ")}</strong>
          {payload.check ? <div className="muted t-detail">{String(payload.check)}</div> : null}
        </>
      ),
    });
  }

  past.sort((a, b) => a.at.getTime() - b.at.getTime());

  const opened = signals.filter((s) => s.type === "opened").length;
  const clicked = signals.filter((s) => s.type === "clicked").length;

  return (
    <>
      <div className="head">
        <div>
          <h1>{name}</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {email}
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
          {/* The reading alone invites the wrong reading: "cold" from a guess and "cold"
              from measured silence call for opposite responses. */}
          {temp && (
            <span className={`pill ${temp.band}`} title={explainTemp(person.temp as Document)}>
              {temp.band} {Math.round(temp.score)}
            </span>
          )}
          {temp && <span className="muted" style={{ fontSize: 12.5 }}>{explainTemp(person.temp as Document)}</span>}
          {person.lifecycle !== "suppressed" && (
            <ConfirmButton
              icon={<Ban />}
              label="Never contact"
              title="Never contact this person again?"
              body="Any campaign they are in stops, anything queued is cancelled, and no future import or audience can pick them up. This cannot be undone from here."
              confirmLabel="Suppress permanently"
              action={suppressPerson.bind(null, id, personId)}
            />
          )}
        </div>
      </div>

      {/* What they did comes before what we spent. The old row led with attempts and
          investment, which is the story from our side of the wire only. */}
      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card stat"><div className="label">Sent</div><div className="value">{sent.length}</div></div>
        <div className={`card stat ${clicked > 0 ? "live" : ""}`}>
          <div className="label">Clicked</div>
          <div className="value">{clicked}</div>
        </div>
        <div className={`card stat ${replies.length > 0 ? "live" : ""}`}>
          <div className="label">Replies</div>
          <div className="value">{replies.length}</div>
        </div>
        <div className="card stat">
          <div className="label">Opened</div>
          <div className="value">{opened}</div>
        </div>
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
                    <td className="muted num" title={istLong(o.at)}>{ist(o.at)}</td>
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
                    <td className="muted num" title={istLong(c.startedAt)}>{ist(c.startedAt)}</td>
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
                      {ist(c.lastVerifiedAt)}
                      {c.status === "active" && c.nextVerifyAt ? (
                        <div style={{ fontSize: 12 }}>next {ist(c.nextVerifyAt)}</div>
                      ) : null}
                    </td>
                    <td className="num">{spent?.touches ?? 0} msg</td>
                    <td>
                      {/* "already met" is neither a win nor a failure — it is a campaign
                          that was correctly not run. Painting it red would read as
                          something having gone wrong. */}
                      <span
                        className={`pill ${
                          c.status === "succeeded" ? "ok" : c.status === "active" || c.status === "already_met" ? "" : "bad"
                        }`}
                      >
                        {String(c.status).replace(/_/g, " ")}
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

      <h2>Activity</h2>
      <p className="sub">
        One sequence: what we sent, what they did about it, and what the product verified — in the order it
        happened. Every message opens as it arrived. Nothing here is ever overwritten.
      </p>
      {past.length === 0 ? (
        <div className="empty"><strong>Nothing yet</strong>They have not been written to.</div>
      ) : (
        <div className="timeline">
          {past.map((entry, i) => (
            <div key={i}>
              <span className="t-when" title={istLong(entry.at)}>{ist(entry.at)}</span>
              <span className={`t-mark ${entry.mark ?? ""}`} />
              <span>{entry.node}</span>
            </div>
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <>
          <h2>Scheduled</h2>
          <p className="sub">Not sent yet. A reply from them cancels whatever is still waiting here.</p>
          <div className="timeline">
            {upcoming.map((action) => {
              const content = (action.content ?? {}) as { subject?: string };
              const due = stamp(action.dueAt);
              return (
                <div key={String(action._id)} className="future">
                  <span className="t-when" title={istLong(action.dueAt)}>{ist(action.dueAt)}</span>
                  <span className="t-mark next" />
                  <span>
                    <div className="t-line">
                      <strong>{content.subject ?? `Message on ${String(action.channel)}`}</strong>
                      <PreviewDrawer
                        productId={id}
                        actionId={String(action._id)}
                        personName={name}
                        personEmail={email}
                        meta={`${String(action.channel)} · due ${ist(action.dueAt)}`}
                        fetchMessage={heldMessage}
                      />
                    </div>
                    <div className="muted t-detail">
                      {action.status === "awaiting_approval"
                        ? "waiting for your review"
                        : due > Date.now()
                          ? "scheduled"
                          : "due now"}
                      {" · "}angle {String(action.angle)}
                    </div>
                    {/* A signal against a message nobody approved means its tracking link
                        was reached some other way — a preview, a test, a link shared on.
                        Silently counting it would credit a send that never happened. */}
                    {action.firstClickedAt || action.firstOpenedAt ? (
                      <div className="t-detail">
                        <span className="pill bad">tracked before it was sent</span>{" "}
                        <span className="muted">
                          A link in this draft was reached {ist(action.firstClickedAt ?? action.firstOpenedAt)}, and it
                          has not gone out. Treat it as a test, not as engagement.
                        </span>
                      </div>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

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
                <span className="muted" style={{ fontSize: 12.5 }}>{ist(plan.createdAt)}</span>
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

const stamp = (value: unknown): number => {
  const date = value ? new Date(String(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
};

/**
 * What one message earned, on the message itself.
 *
 * The timeline carries every signal as its own entry, but a reader scanning for "did this
 * one land" should not have to look further down the page for the answer.
 */
function Result({ action }: { action: Document }) {
  const tracking = (action.tracking ?? {}) as { opens?: boolean; clicks?: boolean };
  const opened = action.firstOpenedAt;
  const clicked = action.firstClickedAt;

  if (!opened && !clicked) {
    return (
      <div className="t-detail">
        <span className="muted">
          {tracking.clicks || tracking.opens
            ? "No response to this one."
            : "Not tracked — this send could not have reported anything."}
        </span>
      </div>
    );
  }

  return (
    <div className="t-detail responded">
      {clicked ? (
        <span className="pill hot" title={istLong(clicked)}>
          <MousePointerClick /> clicked {ist(clicked)}
        </span>
      ) : null}
      {opened ? (
        <span className="pill warm" title={istLong(opened)}>
          <Mail /> opened {ist(opened)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What happened to a message, in the words a person would use.
 *
 * "sent" covered three different states — handed to a queue, confirmed by the provider,
 * and assumed because the provider never says — and a campaign reporting delivery it
 * cannot confirm is worse than one admitting it does not know.
 */
function deliveryLabel(action: Record<string, unknown>): string {
  const status = String(action.status);
  if (status === "dispatched") return "with the provider, not confirmed yet";
  if (status === "failed") return `failed${action.error ? `: ${String(action.error)}` : ""}`;
  if (status !== "sent") return status;
  if (action.confirmedAt) return "delivered — confirmed by the provider";
  return action.providerMessageId ? "sent, awaiting confirmation" : "sent — the provider reports no status";
}
