import type { Document } from "mongodb";
import type { ReactNode } from "react";
import {
  Ban,
  Bot,
  CircleCheck,
  CircleSlash,
  Clock,
  Mail,
  MailX,
  MessageSquare,
  MousePointerClick,
  PhoneCall,
  PhoneMissed,
  Send,
  UserPlus,
} from "lucide-react";
import { gateOpen } from "@/engine/advance.js";
import { personHistory } from "@/engine/library.js";
import { signalsOf } from "@/engine/engagement.js";
import { heldMessage, suppressPerson } from "../../../../actions";
import { requireSession } from "../../../../tenant";
import ConfirmButton from "../../../../ui/confirm";
import ClaudeBadge from "../../../../ui/claude-badge";
import PreviewDrawer from "../../review/preview-drawer";
import { ist, istDay, istLong, istTime, istWeekday } from "../../../../ui/time";

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

  const { person, campaigns, actions, plans, events, names } = history;
  const belief = person.belief as
    | {
        segment: string;
        confidence: number;
        useCase?: string;
        painHypothesis?: string;
        objectionsLikely?: string[];
        reasoning?: string;
        icpFit?: number;
        fitKnown?: boolean;
      }
    | undefined;
  const temp = person.temp as { band: string; score: number } | undefined;
  const booking = person.booking && !(person.booking as { cancelledAt?: Date }).cancelledAt
    ? (person.booking as { label: string; meetLink?: string })
    : null;
  const inv = (person.investment ?? {}) as Record<string, number>;
  const arrivals = (person.arrivals ?? []) as Array<{ kind: string; at: string; detail?: string; intent?: string; sourceId?: string }>;
  const objections = (person.objections ?? []) as Array<{ text: string; at: string; source: string }>;

  const who = identity(person);
  const name = who.title;
  const email = who.email;
  const role = person.role ? humanize(person.role) : "";
  const site = siteOf(person.companyDomain);

  const campaignName = new Map(campaigns.map((c) => [String(c._id), goalName(names.goals, c.goalKey)]));
  const planById = new Map(plans.map((p) => [String(p._id), p]));

  /** The plan step an action was written for, read from its campaign's current plan. */
  const stepFor = (action: Document): Document | undefined => {
    if (action.planStepId == null) return undefined;
    const campaign = campaigns.find((c) => String(c._id) === String(action.goalInstanceId));
    const plan = campaign ? planById.get(String(campaign.currentPlanId)) : undefined;
    const steps = Array.isArray(plan?.steps) ? (plan.steps as Document[]) : [];
    return steps.find((s) => Number(s.id) === Number(action.planStepId));
  };

  /** The name the email has in the templates list — "The four lines", not `four_lines`. */
  const emailName = (action: Document): string =>
    names.templatesById.get(String(action.templateId)) ??
    names.templatesByKey.get(String(stepFor(action)?.templateKey ?? "")) ??
    names.templatesByKey.get(String(action.angle)) ??
    humanize(action.angle);

  const sent = actions.filter((a) => a.status === "sent" || a.status === "dispatched");
  // A step swapped out by a newer plan was never a message: it has no words and no send
  // time, only a due date that may still be in the future. On the timeline it read as
  // something that failed; the earlier plan in "The plan" is where it belongs.
  const stopped = actions.filter(
    (a) => (a.status === "failed" || a.status === "skipped") && a.replacedPlanStepId == null,
  );
  const upcoming = actions
    .filter((a) => ["queued", "awaiting_approval"].includes(String(a.status)))
    .sort((a, b) => stamp(a.dueAt) - stamp(b.dueAt));

  const signals = signalsOf(actions);
  const replies = events.filter((e) => String(e.type) === "reply_received");

  const past: Entry[] = [];

  for (const arrival of arrivals) {
    const sourceName = arrival.sourceId ? names.sources.get(arrival.sourceId) : undefined;
    const detail = [
      arrival.intent === "form" ? "They filled in a form." : null,
      sourceName
        ? `Added from the “${humanize(sourceName)}” list.`
        : `Added from ${ARRIVAL_KIND[arrival.kind] ?? humanize(arrival.kind).toLowerCase()}.`,
      arrival.detail ?? null,
    ].filter(Boolean);
    past.push({
      at: new Date(String(arrival.at)),
      node: (
        <>
          <strong><UserPlus size={13} /> They became a lead</strong>
          <div className="muted t-detail">{detail.join(" ")}</div>
        </>
      ),
    });
  }

  for (const action of sent) {
    const content = (action.content ?? {}) as { subject?: string; ctaUrl?: string };
    const outcome = action.outcome as { grade?: string } | undefined;
    const goal = campaignName.get(String(action.goalInstanceId));
    const why = whyLabel(action.rationale);
    const isCall = String(action.channel) === "voice";
    past.push({
      at: new Date(String(action.sentAt ?? action.dueAt)),
      node: (
        <>
          <div className="t-line">
            {isCall ? (
              <strong>
                <PhoneCall size={13} /> {action.status === "dispatched" ? "We are calling them" : "We called them"}
              </strong>
            ) : (
              <strong><Send size={13} /> We sent “{emailName(action)}”</strong>
            )}
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
          {content.subject || campaigns.length > 1 ? (
            <div className="muted t-detail">
              {[content.subject ? `Subject: “${content.subject}”` : null, campaigns.length > 1 ? goal : null]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}
          {isCall ? (
            <CallDetail action={action} />
          ) : (
            <Result action={action} delivery={`${deliveryLabel(action)}${outcome?.grade ? ` Rated ${outcome.grade}.` : ""}`} />
          )}
          {why ? <div className="muted t-detail">Why: {why}</div> : null}
        </>
      ),
    });
  }

  // A message that never arrived belongs on the timeline as much as one that did. Leaving
  // it off makes a silent week look like a week nobody was written to.
  for (const action of stopped) {
    const content = (action.content ?? {}) as { subject?: string };
    const reason = notSentLabel(action);
    past.push({
      at: new Date(String(action.reviewedAt ?? action.dueAt)),
      mark: reason.bad ? "bad" : undefined,
      node: (
        <>
          <div className="t-line">
            {String(action.channel) === "voice" ? (
              <strong>
                <PhoneMissed size={13} /> {action.status === "failed" ? "Our call did not connect" : "We did not call them"}
              </strong>
            ) : (
              <strong><CircleSlash size={13} /> “{content.subject ?? emailName(action)}” was not sent</strong>
            )}
            <PreviewDrawer
              productId={id}
              actionId={String(action._id)}
              personName={name}
              personEmail={email}
              meta={`${String(action.channel)} · never sent`}
              fetchMessage={heldMessage}
            />
          </div>
          <div className="muted t-detail">{reason.text}</div>
        </>
      ),
    });
  }

  for (const signal of signals) {
    // A gateway walking the links is worth showing and must never look like a reader. It
    // explains a message that appears to have been engaged with within seconds of sending,
    // and it is the reason the counts above are lower than the raw record.
    if (signal.bot) {
      past.push({
        at: signal.at,
        node: (
          <>
            <strong className="muted"><Bot size={13} /> Their mail scanner checked our email</strong>
            <div className="muted t-detail">
              It {signal.type === "clicked" ? "opened the link" : "loaded the images"} seconds after we sent it, before a
              person could read it. We do not count this as interest.
            </div>
          </>
        ),
      });
      continue;
    }

    past.push({
      at: signal.at,
      mark: "signal",
      node:
        signal.type === "clicked" ? (
          <>
            <strong className="hit"><MousePointerClick size={13} /> They clicked a link</strong>
            <div className="muted t-detail">
              {signal.subject ? `In “${signal.subject}”` : "In an earlier email"}
              {signal.url ? <> · <span className="mono">{signal.url}</span></> : null}
            </div>
          </>
        ) : (
          <>
            <strong><Mail size={13} /> They opened an email</strong>
            <div className="muted t-detail">
              {signal.subject ? `“${signal.subject}”. ` : ""}
              This may not be a person: some mail apps open emails on their own.
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
            <strong className="hit"><MessageSquare size={13} /> They replied</strong>
            <div className="muted t-detail">{payload.subject ? `Subject: “${String(payload.subject)}”` : "No subject."}</div>
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
            <strong><Ban size={13} /> They unsubscribed</strong>
            <div className="muted t-detail">
              {payload.reason ? sentence(String(payload.reason)).replace(/\.?$/, ". ") : ""}We will never email them again.
            </div>
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
            <strong><MailX size={13} /> Our email bounced</strong>
            <div className="muted t-detail">{String(payload.recipient ?? email)} does not accept email.</div>
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
            <strong className="hit"><CircleCheck size={13} /> Confirmed: {humanize(type.slice("check_passed:".length)).toLowerCase()}</strong>
            <div className="muted t-detail">This counts toward the campaign goal.</div>
          </>
        ),
      });
      continue;
    }

    past.push({
      at,
      node: (
        <>
          <strong>{humanize(type)}</strong>
          {payload.check ? <div className="muted t-detail">{humanize(payload.check)}</div> : null}
        </>
      ),
    });
  }

  // Only the latest check is stored, so only the latest is shown. A check that passed has its
  // own entry above; this one says what is still not true, and when we look again. Without it
  // the page said "what we checked" and then showed no check at all.
  for (const campaign of campaigns) {
    const pending = Object.entries((campaign.checkResults ?? {}) as Record<string, boolean>)
      .filter(([, passed]) => !passed)
      .map(([key]) => humanize(key).toLowerCase());
    if (!campaign.lastVerifiedAt || pending.length === 0) continue;
    past.push({
      at: new Date(String(campaign.lastVerifiedAt)),
      node: (
        <>
          <strong className="muted"><Clock size={13} /> We checked: not {pending.join(" or ")} yet</strong>
          {campaign.status === "active" && campaign.nextVerifyAt ? (
            <div className="muted t-detail">
              We check again {istWeekday(campaign.nextVerifyAt)} at {istTime(campaign.nextVerifyAt)}.
            </div>
          ) : null}
        </>
      ),
    });
  }

  past.sort((a, b) => a.at.getTime() - b.at.getTime());

  const opened = signals.filter((s) => s.type === "opened" && !s.bot).length;
  const clicked = signals.filter((s) => s.type === "clicked" && !s.bot).length;
  const scanned = signals.filter((s) => s.bot).length;
  // A zero from emails that never carried an open pixel is not a zero: nothing was counting.
  const opensTracked = sent.some((a) => (a.tracking as { opens?: boolean } | undefined)?.opens);

  const interestWhy = interestReasons({
    fit: belief?.fitKnown !== false && Number(belief?.icpFit ?? 0) >= 0.6,
    form: arrivals.some((a) => a.intent === "form"),
    sent: sent.length,
    opened,
    clicked,
    replied: replies.length,
  });

  return (
    <>
      <div className="head">
        <div>
          <h1>{name}</h1>
          <p className="sub person-sub">
            {[
              role ? <span key="role">{role}</span> : null,
              who.tagline ? <span key="tagline">{who.tagline}</span> : null,
              email ? <span key="email">{email}</span> : null,
              site ? <a key="site" href={site.href} target="_blank" rel="noreferrer">{site.label}</a> : null,
            ]
              .filter(Boolean)
              .flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep-${i}`}> · </span>, node]))}
          </p>
        </div>
        <div className="spacer" />
        <div className="row">
          <span className={`pill ${person.lifecycle === "suppressed" ? "bad" : person.lifecycle === "active" ? "ok" : ""}`}>
            {lifecycleLabel(person.lifecycle)}
          </span>
          {/* The reading alone invites the wrong reading: "cold" from a guess and "cold"
              from measured silence call for opposite responses. */}
          {temp && (
            <span className={`pill ${temp.band}`} title={`Interest score ${Math.round(temp.score)}`}>
              {BAND_LABEL[temp.band] ?? humanize(temp.band)}
            </span>
          )}
          {temp && interestWhy && <span className="muted temp-why">{interestWhy}</span>}
          {/* A booked call is the one event that hands this person to a human, so it sits
              beside the lifecycle where a reader looks first. Label and link come from the
              booking itself; the calendar event is the record, this is the pointer to it. */}
          {booking && (
            <span className="pill ok" title={booking.meetLink ? `Meet: ${booking.meetLink}` : undefined}>
              {booking.meetLink ? <a href={booking.meetLink} target="_blank" rel="noreferrer">call booked · {booking.label}</a> : <>call booked · {booking.label}</>}
            </span>
          )}
          {person.lifecycle !== "suppressed" && (
            <ConfirmButton
              icon={<Ban />}
              label="Never contact"
              title="Never contact this person again?"
              body="Every campaign they are in stops, any email waiting to go out is cancelled, and no future import or audience can add them back. This cannot be undone from here."
              confirmLabel="Never contact them"
              action={suppressPerson.bind(null, id, personId)}
            />
          )}
        </div>
      </div>

      {/* What they did comes before what we spent. The old row led with attempts and
          investment, which is the story from our side of the wire only. */}
      <div className="grid stat-row">
        <div className="card stat"><div className="label">Emails sent</div><div className="value">{sent.length}</div></div>
        <div className={`card stat ${clicked > 0 ? "live" : ""}`}>
          <div className="label">Clicked</div>
          <div className="value">{clicked}</div>
        </div>
        <div className={`card stat ${replies.length > 0 ? "live" : ""}`}>
          <div className="label">Replied</div>
          <div className="value">{replies.length}</div>
        </div>
        <div className="card stat" title={opensTracked || opened > 0 ? undefined : "Opens are not tracked for the emails sent so far"}>
          <div className="label">Opened</div>
          {opensTracked || opened > 0 ? (
            <div className="value">{opened}</div>
          ) : (
            <div className="value muted">—</div>
          )}
        </div>
        {scanned > 0 && (
          <div className="card stat" title="Their mail scanner opening links in the seconds after a send. Not counted anywhere above.">
            <div className="label">Mail scanner</div>
            <div className="value muted">{scanned}</div>
          </div>
        )}
        <div className="card stat"><div className="label">Cost so far</div><div className="value">${Number(inv.usd ?? 0).toFixed(2)}</div></div>
        <div className="card stat"><div className="label">Campaigns</div><div className="value">{campaigns.length}</div></div>
      </div>

      <h2>Who they are</h2>
      {belief ? (
        <div className="card belief">
          <div className="belief-head">
            <strong>{names.segments.get(belief.segment) ?? humanize(belief.segment)}</strong>
            <span className="muted">{sureness(belief.confidence)}</span>
          </div>
          {role || who.tagline ? (
            <p>{[role, who.tagline ? `at ${name} (${who.tagline})` : `at ${name}`].filter(Boolean).join(" ")}</p>
          ) : null}
          {belief.painHypothesis && <p><span className="muted">What they likely struggle with:</span> {belief.painHypothesis}</p>}
          {belief.useCase && <p><span className="muted">How we can help:</span> {belief.useCase}</p>}
          {belief.objectionsLikely?.length ? (
            <p><span className="muted">Likely worries:</span> {belief.objectionsLikely.join(" · ")}</p>
          ) : null}
          {belief.reasoning && <p className="muted">Why we think so: {belief.reasoning}</p>}
        </div>
      ) : (
        <p className="sub"><ClaudeBadge note="not sorted yet" /> Claude sorts new leads into a group on its next run.</p>
      )}

      {objections.length > 0 && (
        <>
          <h2>What they have told us</h2>
          <p className="sub">Kept across every campaign, so a later email starts from what they actually said.</p>
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
        <div className="empty"><strong>Not in a campaign yet</strong>They are saved in your leads, waiting.</div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr><th>Campaign</th><th>Started</th><th>Goal</th><th>Last checked</th><th>Sent</th><th>Status</th></tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const spent = c.spent as { touches: number; usd: number };
                const goal = names.goals.get(String(c.goalKey));
                const checks = Object.entries((c.checkResults ?? {}) as Record<string, boolean>);
                const touches = spent?.touches ?? 0;
                return (
                  <tr key={String(c._id)}>
                    <td>{campaignName.get(String(c._id))}</td>
                    <td className="muted num" title={istLong(c.startedAt)}>{ist(c.startedAt)}</td>
                    <td>
                      {goal?.success?.describedAs ? <div>{String(goal.success.describedAs)}</div> : null}
                      {checks.length === 0 ? (
                        <span className="muted">not checked yet</span>
                      ) : (
                        checks.map(([key, passed]) => (
                          <div key={key}>
                            <span className={`pill ${passed ? "ok" : ""}`}>
                              {passed ? `✓ ${humanize(key)}` : `Not yet: ${humanize(key).toLowerCase()}`}
                            </span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="muted num">
                      {ist(c.lastVerifiedAt, "not yet")}
                      {c.status === "active" && c.nextVerifyAt ? (
                        <div className="cell-note">next check {ist(c.nextVerifyAt)}</div>
                      ) : null}
                    </td>
                    <td className="num">{touches} {touches === 1 ? "email" : "emails"}</td>
                    <td>
                      {/* "already met" is neither a win nor a failure — it is a campaign
                          that was correctly not run. Painting it red would read as
                          something having gone wrong. */}
                      <span
                        className={`pill ${
                          c.status === "succeeded" ? "ok" : c.status === "active" || c.status === "already_met" ? "" : "bad"
                        }`}
                      >
                        {CAMPAIGN_STATUS[String(c.status)] ?? humanize(c.status)}
                      </span>
                      {c.status === "active" && c.deadline ? (
                        <div className="muted cell-note">ends {istDay(c.deadline)}</div>
                      ) : null}
                      {c.outcome ? <div className="muted cell-note">{String(c.outcome)}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Activity</h2>
      <p className="sub">What happened with this lead, oldest first. Open any email to see exactly what they got.</p>
      {past.length === 0 ? (
        <div className="empty"><strong>Nothing yet</strong>We have not emailed them.</div>
      ) : (
        <div className="timeline">
          {past.map((entry, i) => (
            <div key={i}>
              <WhenCell at={entry.at} />
              <span className={`t-mark ${entry.mark ? `m-${entry.mark}` : ""}`} />
              <span>{entry.node}</span>
            </div>
          ))}
        </div>
      )}

      {upcoming.length > 0 && (
        <>
          <h2>Coming up</h2>
          <p className="sub">Emails waiting to go out. If they reply, these are cancelled.</p>
          <div className="timeline">
            {upcoming.map((action) => {
              const content = (action.content ?? {}) as { subject?: string };
              const due = stamp(action.dueAt);
              const gate = gateNote(stepFor(action)?.gate);
              return (
                <div key={String(action._id)} className="future">
                  <WhenCell at={action.dueAt} />
                  <span className="t-mark m-next" />
                  <span>
                    <div className="t-line">
                      <strong>
                        {String(action.channel) === "voice" ? "We will call them" : `We will send “${emailName(action)}”`}
                      </strong>
                      <PreviewDrawer
                        productId={id}
                        actionId={String(action._id)}
                        personName={name}
                        personEmail={email}
                        meta={`${String(action.channel)} · due ${ist(action.dueAt)}`}
                        fetchMessage={heldMessage}
                      />
                    </div>
                    {content.subject ? <div className="muted t-detail">Subject: “{content.subject}”</div> : null}
                    <div className="muted t-detail">
                      {[
                        action.status === "awaiting_approval"
                          ? "Waiting for your review before it goes out."
                          : due > Date.now()
                            ? `Goes out ${istWeekday(action.dueAt)} at ${istTime(action.dueAt)}.`
                            : "Going out now.",
                        gate,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </div>
                    {/* A signal against a message nobody approved means its tracking link
                        was reached some other way — a preview, a test, a link shared on.
                        Silently counting it would credit a send that never happened. */}
                    {action.firstClickedAt || action.firstOpenedAt ? (
                      <div className="t-detail">
                        <span className="pill bad">link used before sending</span>{" "}
                        <span className="muted">
                          Someone used a link in this draft {ist(action.firstClickedAt ?? action.firstOpenedAt)}, but it
                          has not gone out. Treat it as a test, not as interest.
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
          <h2>The plan</h2>
          <p className="sub">Every email we plan to send them, and when. If the plan changes, older versions stay at the bottom.</p>
          {campaigns.map((campaign) => {
            const own = plans.filter((p) => String(p.goalInstanceId) === String(campaign._id));
            const current = own.find((p) => String(p._id) === String(campaign.currentPlanId)) ?? own.at(-1);
            if (!current) return null;
            const older = own.filter((p) => p !== current).reverse();
            const campaignActions = actions.filter((a) => String(a.goalInstanceId) === String(campaign._id));
            const engagement = {
              opened: campaignActions.some((a) => Boolean(a.firstOpenedAt)),
              clicked: campaignActions.some((a) => Boolean(a.firstClickedAt)),
              band: temp?.band,
            };
            const rows = planRows(current, campaignActions, engagement, (key, action) => ({
              name:
                (action ? names.templatesById.get(String(action.templateId)) : undefined) ??
                names.templatesByKey.get(String(key ?? "")) ??
                humanize(key),
              blurb:
                (action ? names.blurbsById.get(String(action.templateId)) : undefined) ??
                names.blurbsByKey.get(String(key ?? "")) ??
                null,
            }));
            const lastIndex = rows.map((row) => row.state !== "skipped").lastIndexOf(true);
            const goal = names.goals.get(String(campaign.goalKey));
            return (
              <div key={String(campaign._id)}>
                {campaigns.length > 1 && <h3>{campaignName.get(String(campaign._id))}</h3>}
                {/* Read as a calendar, not a recipe. The card used to open on "PLAN 3 · in use ·
                    standard plan" and give each step as a gap after the one before, so the
                    reader had to add days up to learn when anything would arrive. */}
                <div className="card plan-card">
                  <p className="plan-lead">{planHeadline(rows)}</p>
                  <p className="muted cell-note">
                    Emails stop as soon as they reply
                    {goal?.success?.describedAs ? ` or the goal is reached (${lowerFirst(String(goal.success.describedAs))})` : ""}.
                    Dates after the next email are our best estimate.
                  </p>
                  <div className="timeline plan-timeline">
                    {rows.map((row, i) => (
                      <div key={row.key} className={row.state === "later" ? "future" : row.state === "skipped" ? "future skipped" : ""}>
                        <span className="t-when" title={row.date ? istLong(row.date) : undefined}>
                          {row.date ? istWeekday(row.date) : "—"}
                        </span>
                        <span className={`t-mark ${PLAN_MARK[row.state]}`} />
                        <span title={row.why ?? undefined}>
                          <div className="t-line">
                            <strong>{row.name}</strong>
                            {row.state === "sent" && <span className="pill ok">sent</span>}
                            {row.state === "next" && <span className="pill accent">next</span>}
                            {i === lastIndex && row.state !== "sent" && <span className="muted cell-note">last email</span>}
                          </div>
                          {row.blurb ? <div className="t-detail">{sentence(row.blurb)}</div> : null}
                          {row.why && current.createdBy !== "playbook" ? (
                            <div className="muted t-detail">Why: {sentence(row.why)}</div>
                          ) : null}
                          {row.note ? <div className="muted t-detail">{row.note}</div> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="muted cell-note">
                    {planSummary(current, names.segments, goal)} · updated {ist(current.createdAt)}
                    {current.createdBy === "claude" ? <> <ClaudeBadge note="wrote this plan" /></> : null}
                  </p>
                </div>
                {older.length > 0 && (
                  <details className="plan-older">
                    <summary>Earlier versions of this plan ({older.length})</summary>
                    {older.map((plan) => (
                      <PlanCard
                        key={String(plan._id)}
                        plan={plan}
                        segments={names.segments}
                        templateName={(key) => names.templatesByKey.get(key)}
                      />
                    ))}
                  </details>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

/**
 * A plan that is no longer in use, kept for what it intended. Its steps were never going to
 * be sent from here, so it carries no dates and no state.
 */
function PlanCard({
  plan,
  segments,
  templateName,
}: {
  plan: Document;
  segments: Map<string, string>;
  templateName: (key: string) => string | undefined;
}) {
  // A plan is stored as whatever the session handed over, and one arrived with no
  // steps at all. The page must still open: a person whose history cannot be read
  // is worse than a plan that is shown as empty.
  const steps = Array.isArray(plan.steps) ? (plan.steps as Document[]) : [];
  return (
    <div className="card plan-card">
      <div className="row">
        <span className="label plan-label">version {String(plan.version)}</span>
        {/* Only a plan Claude actually wrote gets Claude's mark. Every plan used to carry
            it, including the ones stamped unchanged from a playbook. */}
        {plan.createdBy === "claude" ? <ClaudeBadge note="wrote this plan" /> : null}
        <span className="muted cell-note">made {ist(plan.createdAt)}</span>
      </div>
      <p>{planSummary(plan, segments)}</p>
      {steps.length === 0 ? (
        <p className="muted plan-empty">This version has no emails in it, so nothing can be sent from it.</p>
      ) : (
        <ol className="plan-steps">
          {steps.map((step, i) => {
            const gate = gateLabel(step.gate);
            return (
              <li key={i}>
                <div className="plan-step-line">
                  <strong>{templateName(String(step.templateKey ?? "")) ?? templateName(String(step.angle)) ?? humanize(step.angle)}</strong>
                  <span className="muted">{[waitLabel(step), gate].filter(Boolean).join(" · ")}</span>
                </div>
                {step.why ? <div className="muted">{String(step.why)}</div> : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const ARRIVAL_KIND: Record<string, string> = {
  mcp_source: "a connected lead source",
  excel_upload: "a spreadsheet upload",
  api_pull: "an import",
  manual: "someone on your team",
};

const BAND_LABEL: Record<string, string> = {
  hot: "Very interested",
  warm: "Some interest",
  cold: "No interest yet",
};

const CAMPAIGN_STATUS: Record<string, string> = {
  active: "In progress",
  succeeded: "Goal reached",
  already_met: "Already done",
  failed: "Did not work",
  expired: "Ran out of time",
  stopped: "Stopped",
  cancelled: "Stopped",
};

const ACRONYMS = new Set(["ceo", "cto", "coo", "cfo", "cmo", "hr", "vp", "it", "ui", "ux", "qa", "api", "ai", "mcp"]);

/**
 * A stored key in the words a person would say: `founder_/_ceo_/_owner` becomes
 * "Founder / CEO / owner". Only a fallback — a real name from the product always wins.
 */
function humanize(value: unknown): string {
  const text = String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()))
    .join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The heading and the line under it.
 *
 * A lead source hands over whatever name it has, and for a form lead that is often the
 * company's page title — "Bricolage Bombay | Design & Media Consultancy" — which then sat
 * where a person's name goes. Split on the bar, so the heading names the company and the
 * tagline reads as a description.
 */
function identity(person: Document): { title: string; tagline: string; email: string } {
  const email = String(person.primaryEmail ?? "");
  const [first, ...rest] = String(person.name ?? "")
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return { title: first || email || "Unknown", tagline: rest.join(" · "), email };
}

function siteOf(value: unknown): { href: string; label: string } | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return {
    href: /^https?:\/\//i.test(text) ? text : `https://${text}`,
    label: text.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, ""),
  };
}

function lifecycleLabel(value: unknown): string {
  const state = String(value ?? "new");
  if (state === "active") return "In progress";
  if (state === "suppressed") return "Never contact";
  return humanize(state);
}

function goalName(goals: Map<string, Document>, key: unknown): string {
  const goal = goals.get(String(key));
  return goal?.name ? String(goal.name) : humanize(key);
}

function sureness(confidence: number): string {
  const pct = Math.round(Number(confidence) * 100);
  const word = pct >= 85 ? "very sure" : pct >= 60 ? "fairly sure" : pct >= 40 ? "not very sure" : "a guess";
  return `${word} (${pct}%)`;
}

/**
 * Why the interest pill reads what it does, from what actually happened.
 *
 * The engine's own list names the terms it weighed, not the ones that fired: "clicks"
 * appeared on a person who had never clicked, beside a Clicked count of zero.
 */
function interestReasons(s: { fit: boolean; form: boolean; sent: number; opened: number; clicked: number; replied: number }): string {
  const parts: string[] = [];
  if (s.fit) parts.push("good fit");
  if (s.form) parts.push("asked through a form");
  if (s.replied > 0) parts.push("replied");
  if (s.clicked > 0) parts.push("clicked a link");
  else if (s.opened > 0) parts.push("opened an email");
  if (s.sent > 0 && s.clicked === 0 && s.replied === 0) parts.push("no clicks or replies yet");
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function whyLabel(rationale: unknown): string | null {
  const text = String(rationale ?? "").trim();
  if (!text) return null;
  if (/^first touch for goal/i.test(text)) return "it is the first email of this campaign.";
  return text;
}

/** The condition a step waits on, as a sentence fragment. */
function gateLabel(gate: unknown): string | null {
  switch (String(gate ?? "").trim().toLowerCase()) {
    case "no_open": return "only if they have not opened any email";
    case "no_click": return "only if they have not clicked anything";
    case "warm": return "only once they show interest";
    case "cold": return "only if they have gone quiet";
    default: return null;
  }
}

interface PlanRow {
  key: string;
  date: Date | null;
  name: string;
  blurb: string | null;
  why: string | null;
  state: "sent" | "next" | "later" | "skipped";
  note: string | null;
}

const PLAN_MARK: Record<PlanRow["state"], string> = { sent: "", next: "m-next", later: "m-later", skipped: "m-later" };

const DAY_MS = 86_400_000;

/**
 * The plan in use as dated rows: what went out, what is next, and what follows.
 *
 * The first email goes out before any plan exists, so it is not one of its steps; it is
 * added at the top, or the plan would open on the second email with no sign that anything
 * had been sent. A step with nothing written yet is dated from the one before it, using the
 * same gap the engine waits, and a step whose gate has already shut is shown as skipped
 * rather than dropped.
 */
function planRows(
  plan: Document,
  campaignActions: Document[],
  engagement: { opened: boolean; clicked: boolean; band?: string },
  label: (key: unknown, action?: Document) => { name: string; blurb: string | null },
): PlanRow[] {
  const rows: PlanRow[] = campaignActions
    .filter((a) => a.planStepId == null && a.replacedPlanStepId == null && ["sent", "dispatched"].includes(String(a.status)))
    .sort((a, b) => stamp(a.sentAt ?? a.dueAt) - stamp(b.sentAt ?? b.dueAt))
    .map((a) => ({ key: String(a._id), date: toDate(a.sentAt ?? a.dueAt), ...label(a.angle, a), why: null, state: "sent", note: null }));

  let previous = rows.at(-1)?.date ?? null;
  const steps = (Array.isArray(plan.steps) ? (plan.steps as Document[]) : []).slice().sort((a, b) => Number(a.id) - Number(b.id));
  for (const step of steps) {
    const action = campaignActions
      .filter((a) => Number(a.planStepId) === Number(step.id))
      .sort((a, b) => stamp(b.dueAt) - stamp(a.dueAt))[0];
    const base = { key: `step-${String(step.id)}`, ...label(step.templateKey ?? step.angle, action), why: step.why ? String(step.why) : null };
    const status = String(action?.status ?? "");

    if (action && (status === "sent" || status === "dispatched")) {
      const date = toDate(action.sentAt ?? action.dueAt);
      rows.push({ ...base, date, state: "sent", note: null });
      previous = date;
    } else if (action && ["queued", "awaiting_approval", "sending"].includes(status)) {
      const date = toDate(action.dueAt);
      rows.push({
        ...base,
        date,
        state: "later",
        note: status === "awaiting_approval" ? "Waiting for your review before it goes out." : gateNote(step.gate),
      });
      previous = date;
    } else if (action) {
      rows.push({ ...base, date: null, state: "skipped", note: "Not sent." });
    } else if (!gateOpen(step.gate, engagement) && ["no_open", "no_click"].includes(String(step.gate))) {
      rows.push({
        ...base,
        date: null,
        state: "skipped",
        note: step.gate === "no_open" ? "Skipped: they already opened an email." : "Skipped: they already clicked a link.",
      });
    } else {
      const days = Number(step.offsetDays ?? step.after_days ?? step.afterDays);
      const date = previous && Number.isFinite(days) ? new Date(previous.getTime() + days * DAY_MS) : null;
      rows.push({ ...base, date, state: "later", note: gateNote(step.gate) });
      previous = date;
    }
  }

  const next = rows.find((row) => row.state === "later");
  if (next) next.state = "next";
  return rows;
}

/** One sentence that says where the plan is: "1 of 6 emails sent. Next one Tue 15 Sep, last one Mon 21 Sep." */
function planHeadline(rows: PlanRow[]): string {
  const sent = rows.filter((row) => row.state === "sent").length;
  const coming = rows.filter((row) => row.state === "next" || row.state === "later");
  if (coming.length === 0) {
    return sent === 0 ? "Nothing planned yet." : `All ${sent} ${sent === 1 ? "email" : "emails"} sent. Nothing left to send.`;
  }
  const when = (row: PlanRow | undefined) => (row?.date ? istWeekday(row.date) : null);
  let text = `${sent} of ${sent + coming.length} emails sent. Next one ${when(coming[0]) ?? "once they qualify"}`;
  if (coming.length > 1 && when(coming.at(-1))) text += `, last one ${when(coming.at(-1))}`;
  return `${text}.`;
}

/** The condition a step still waits on, as a full sentence under it. */
function gateNote(gate: unknown): string | null {
  switch (String(gate ?? "").trim().toLowerCase()) {
    case "no_open": return "Skipped if they open an email before this.";
    case "no_click": return "Skipped if they click a link before this.";
    case "warm": return "Only sent once they show interest.";
    case "cold": return "Only sent if they go quiet.";
    default: return null;
  }
}

/** A preview line is written lower-case, the way it reads in an inbox. Under a heading it wants capitals. */
function sentence(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const toDate = (value: unknown): Date | null => {
  const at = stamp(value);
  return at ? new Date(at) : null;
};

function planSummary(plan: Document, segments: Map<string, string>, goal?: Document): string {
  const rationale = String(plan.rationale ?? "").trim();
  if (plan.createdBy === "claude" || plan.createdBy === "human") return rationale;
  // A campaign that plans each lead stamps these only so nobody waits with nothing.
  if ((goal?.perLeadPlan as { family?: string } | undefined)?.family) {
    return "Standard steps until Claude plans this lead, usually within the hour";
  }
  const segment = /the (\S+) playbook/i.exec(rationale)?.[1];
  if (segment && segment !== "default") {
    return `Standard plan for the “${segments.get(segment) ?? humanize(segment)}” group`;
  }
  return "Standard plan for every lead in this campaign";
}

/**
 * How long a plan step waits, in words. Playbook stamps store offsetDays; session-written
 * plans store after_days. Either way it is the gap after the previous message, not a day of
 * the campaign.
 */
const waitLabel = (step: Record<string, unknown>): string => {
  const days = Number(step.offsetDays ?? step.after_days ?? step.afterDays);
  if (!Number.isFinite(days)) return "timing not set";
  return `${days} ${days === 1 ? "day" : "days"} after the previous email`;
};

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
function Result({ action, delivery }: { action: Document; delivery: string }) {
  const tracking = (action.tracking ?? {}) as { opens?: boolean; clicks?: boolean };
  const opened = action.firstOpenedAt;
  const clicked = action.firstClickedAt;

  if (!opened && !clicked) {
    const scanned = action.firstMachineClickedAt ?? action.firstMachineOpenedAt;
    return (
      <div className="muted t-detail">
        {delivery}{" "}
        {scanned
          ? "No response from them yet, only their mail scanner."
          : tracking.clicks && !tracking.opens
            ? "No clicks yet."
            : tracking.clicks || tracking.opens
              ? "No opens or clicks yet."
              : "We cannot see if they opened or clicked it."}
      </div>
    );
  }

  return (
    <>
      <div className="muted t-detail">{delivery}</div>
      <div className="t-detail responded">
        {clicked ? (
          <span className="pill hot" title={istLong(clicked)}>
            <MousePointerClick /> they clicked · {istWeekday(clicked)}, {istTime(clicked)}
          </span>
        ) : null}
        {opened ? (
          <span className="pill warm" title={istLong(opened)}>
            <Mail /> they opened · {istWeekday(opened)}, {istTime(opened)}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** When a timeline entry happened: the day on one line and the time under it. */
function WhenCell({ at }: { at: Date | string }) {
  return (
    <span className="t-when" title={istLong(at)}>
      {istWeekday(at)}
      <span className="t-time">{istTime(at)}</span>
    </span>
  );
}

/** What Claude read a call as, in the words the lead page uses. */
const CALL_OUTCOME: Record<string, { label: string; tone: string }> = {
  interested: { label: "interested", tone: "hot" },
  callback: { label: "call back", tone: "warm" },
  not_now: { label: "not now", tone: "" },
  not_interested: { label: "not interested", tone: "bad" },
  wrong_person: { label: "wrong person", tone: "bad" },
  voicemail: { label: "voicemail", tone: "" },
  do_not_call: { label: "do not call", tone: "bad" },
};

/** Why a call never became a conversation, from the provider's own status word. */
const CALL_NOT_CONNECTED: Record<string, string> = {
  "no-answer": "Nobody picked up.",
  busy: "The line was busy.",
  canceled: "The call was cancelled before it rang.",
  stopped: "The call was stopped.",
  "balance-low": "The Bolna balance ran out before it dialled.",
};

/**
 * How a call went, in the order a reader asks: did they pick up, for how long, what did it
 * come to — and then, for whoever wants it, what was actually said.
 */
function CallDetail({ action }: { action: Document }) {
  const call = action.call as
    | {
        durationSec?: number;
        summary?: string;
        transcript?: string;
        recordingUrl?: string;
        outcome?: string;
        reason?: string;
        callbackAt?: Date;
      }
    | undefined;
  if (!call) return <div className="muted t-detail">{deliveryLabel(action)}</div>;

  const outcome = call.outcome ? CALL_OUTCOME[call.outcome] : undefined;
  return (
    <>
      <div className="muted t-detail">
        They picked up and talked for {callLength(call.durationSec)}.
        {call.outcome ? "" : " Claude has not read the call yet."}
      </div>
      {call.outcome ? (
        <div className="t-detail">
          <span className={`pill ${outcome?.tone ?? ""}`}>{outcome?.label ?? humanize(call.outcome)}</span>{" "}
          <span className="muted">
            {call.reason}
            {call.callbackAt ? ` Call back ${istWeekday(call.callbackAt)} at ${istTime(call.callbackAt)}.` : ""}
          </span>
        </div>
      ) : null}
      {call.summary ? <div className="muted t-detail">{call.summary}</div> : null}
      {call.transcript || call.recordingUrl ? (
        <details className="t-detail">
          <summary>What was said</summary>
          {call.recordingUrl ? (
            <p>
              <a href={call.recordingUrl} target="_blank" rel="noreferrer">Listen to the recording</a>
            </p>
          ) : null}
          {call.transcript ? <blockquote className="t-quote">{call.transcript}</blockquote> : null}
        </details>
      ) : null}
    </>
  );
}

function callLength(seconds: number | undefined): string {
  if (!seconds) return "under a second";
  const s = Math.round(seconds);
  return s < 60 ? `${s} seconds` : `${Math.floor(s / 60)}m ${s % 60}s`;
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
  if (status === "dispatched" && action.channel === "voice") return "Calling now. The result comes in once they hang up.";
  if (status === "dispatched") return "Handed to the mail service, not confirmed yet.";
  if (status === "failed") return `Sending failed${action.error ? `: ${String(action.error)}` : ""}.`;
  if (status !== "sent") return `${humanize(status)}.`;
  if (action.confirmedAt) return "Delivered.";
  return action.providerMessageId ? "Sent, delivery not confirmed yet." : "Sent. The mail service gives no delivery status.";
}

/** Why a message never went out. The stored reasons are written for the engine's log. */
function notSentLabel(action: Record<string, unknown>): { text: string; bad: boolean } {
  if (action.status === "failed" && action.channel === "voice") {
    const status = String((action.call as { status?: string } | undefined)?.status ?? "");
    return {
      text: CALL_NOT_CONNECTED[status] ?? `The call could not be placed${action.error ? ` (${String(action.error)})` : ""}.`,
      // Nobody picking up is a Tuesday, not a fault.
      bad: status !== "no-answer" && status !== "busy",
    };
  }
  if (action.skipReason === "asked not to be called") return { text: "They asked not to be called.", bad: true };
  if (action.status === "failed") return { text: `Sending failed${action.error ? ` (${String(action.error)})` : ""}.`, bad: true };
  const reason = String(action.skipReason ?? "");
  const missing = /^no (\w+) on this person/.exec(reason);
  if (missing) return { text: `We do not have their ${missing[1]}.`, bad: false };
  const known: Record<string, { text: string; bad: boolean }> = {
    booked_call: { text: "They booked a call, so it was no longer needed.", bad: false },
    "they replied; waiting on a human answer": { text: "They replied, so it waits for you to answer them.", bad: false },
    hard_bounce: { text: "Their address does not accept email.", bad: true },
    "campaign already succeeded": { text: "They already reached the goal.", bad: false },
    "campaign ended": { text: "The campaign ended first.", bad: false },
    unsubscribed: { text: "They unsubscribed.", bad: true },
    "plan replaced by playbook stamp": { text: "The plan changed before it was due.", bad: false },
    "plan replaced by Claude's plan for this lead": { text: "Claude wrote a new plan for them before it was due.", bad: false },
  };
  if (known[reason]) return known[reason];
  return { text: reason ? `Reason: ${humanize(reason)}.` : "It was turned down in review.", bad: true };
}
