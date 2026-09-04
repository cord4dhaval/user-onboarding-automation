import { CircleCheck, Mail, MousePointerClick, MessageSquare, Pause, Play, Send, Target } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import type { McpTool } from "@/mcp/client.js";
import { audienceCount } from "@/engine/library.js";
import { campaignEngagement, rate, type Engagement } from "@/engine/engagement.js";
import { createGoal, deleteGoal, toggleGoal, updateGoal } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import ClaudeBadge from "../../../ui/claude-badge";
import AutoRefresh from "../../../ui/auto-refresh";
import { ActionButton } from "../../../ui/kit";
import GoalDrawer from "./goal-drawer";

export const dynamic = "force-dynamic";

interface GoalCheck {
  key: string;
  tool: string;
  describedAs?: string;
}

const checksOf = (goal: Record<string, unknown>): GoalCheck[] =>
  ((goal.checks ?? []) as GoalCheck[]);

export default async function Goals({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);
  const base = `/products/${id}`;

  const [goals, templates, sources, connections, bindings, channels] = await Promise.all([
    db.collection(C.goals).find(s).toArray(),
    db.collection(C.templates).find({ ...s, status: "active" }).toArray(),
    db.collection(C.sources).find(s).toArray(),
    db.collection(C.connections).find({ ...s, serverUrl: { $exists: true } }).toArray(),
    db.collection(C.mcpBindings).find({ orgId }).toArray(),
    db.collection(C.channels).find({ ...s, enabled: true }).toArray(),
  ]);

  // Every click this product has ever collected, grouped by the campaign that earned it.
  // One read for the page: a per-row lookup here is one round trip per campaign to render
  // a column that is four numbers wide.
  const responses = await campaignEngagement(orgId, id);

  const audienceDocs = await db.collection(C.audiences).find(s).sort({ createdAt: -1 }).toArray();
  const audiences = await Promise.all(
    audienceDocs.map(async (a) => ({
      id: String(a._id),
      name: String(a.name),
      kind: String(a.kind),
      size: await audienceCount(orgId, id, a),
    })),
  );

  // One flat list of "connection → tool", so a tool can never be paired with the wrong
  // server and the choice needs no client-side wiring.
  const toolChoices = connections
    .flatMap((c) => {
      const binding = bindings.find((b) => String(b.connectionId) === String(c._id));
      return ((binding?.discoveredTools ?? []) as McpTool[]).map((t) => ({
        value: `${String(c._id)}::${t.name}`,
        label: `${String(c.provider)} → ${t.name}`,
        likely: /lead|contact|signup|pipeline|crm|subscriber|new_user/i.test(t.name),
      }));
    })
    .sort((a, b) => Number(b.likely) - Number(a.likely));

  // Only connections with a discovered tool list can be reasoned about as a verifier.
  const verifiers = connections
    .map((c) => {
      const binding = bindings.find((b) => String(b.connectionId) === String(c._id));
      return {
        id: String(c._id),
        provider: String(c.provider),
        tools: ((binding?.discoveredTools ?? []) as unknown[]).length,
      };
    })
    .filter((v) => v.tools > 0);

  const templateKeys = [...new Set(templates.map((t) => String(t.key)))];
  const channelKeys = [...new Set(channels.map((c) => String(c.key)))];

  // An upload is ingested by the clock, not by the request that uploaded it, so a source
  // can be part-way through. One grouped read answers it for every source on the page.
  const pendingChunks = await db
    .collection(C.workQueue)
    .aggregate([
      { $match: { orgId, kind: "ingest_rows", status: { $in: ["queued", "running"] } } },
      { $group: { _id: "$payload.sourceId", chunks: { $sum: 1 } } },
    ])
    .toArray();
  const queuedFor = new Map(pendingChunks.map((c) => [String(c._id), Number(c.chunks)]));

  /**
   * Three states, not two. A source with rows outstanding and nothing left in the queue is
   * not importing — it is an import that stopped, and saying "importing" forever would
   * hide that.
   */
  const importOf = (src: Record<string, unknown>) => {
    const progress = src.progress as { done?: number; total?: number } | undefined;
    const total = Number(progress?.total ?? 0);
    const done = Number(progress?.done ?? 0);
    if (total === 0 || done >= total) return null;
    return { done, total, stalled: !queuedFor.has(String(src._id)) };
  };

  const rows = await Promise.all(
    goals.map(async (g) => ({
      goal: g,
      active: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "active" }),
      done: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "succeeded" }),
      feeding: sources.filter((src) => String(src.defaultGoalKey) === String(g.key)),
      importing: sources
        .filter((src) => String(src.defaultGoalKey) === String(g.key))
        .some((src) => importOf(src)?.stalled === false),
    })),
  );

  const awaitingPlan = rows.filter(({ goal }) => checksOf(goal).length === 0).length;

  return (
    <>
      <AutoRefresh active={rows.some((r) => r.importing)} />

      <div className="head">
        <div>
          <h1>Campaigns</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Who comes in, what they get, and what counts as done.
          </p>
        </div>
        <div className="spacer" />
        <GoalDrawer
          productId={id}
          templateKeys={templateKeys}
          channelKeys={channelKeys}
          toolChoices={toolChoices}
          audiences={audiences}
          verifiers={verifiers}
          action={createGoal}
        />
      </div>

      {awaitingPlan > 0 && (
        <div className="note">
          <p style={{ margin: 0 }}>
            <ClaudeBadge note="writing verification plans" />{" "}
            {awaitingPlan === 1 ? "One campaign is" : `${awaitingPlan} campaigns are`} waiting on Claude to work
            out which tools prove success. They send normally meanwhile — they just cannot mark anyone as
            finished. The Plan routine handles it on its next run.
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          <strong>No campaigns yet</strong>
          A campaign takes people from somewhere and drives them toward something.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Comes from</th>
                <th>Done when</th>
                <th className="num">People</th>
                <th>What came back</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ goal, active, done, feeding, importing }) => {
                const sch = goal.schedule as { fetchEverySec: number; approvalMode: string };
                const budget = goal.budget as { touches: number; days: number };
                const ft = goal.firstTouch as { templateKey: string; channels: string[] };
                const usable = channelKeys.some((k) => ft.channels.includes(k));
                const paused = goal.enabled === false;
                const checks = checksOf(goal);

                return (
                  <tr key={String(goal._id)}>
                    <td>
                      <strong>{String(goal.name)}</strong>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        <code>{ft.templateKey}</code> via {ft.channels.join(" → ") || "no channel"}
                      </div>
                    </td>

                    <td>
                      {/* Running has to mean someone is actually in flight. Deciding it from
                          configuration alone left a campaign whose people had all finished
                          reporting itself as running with nobody in it. */}
                      {paused ? (
                        <span className="status"><span className="dot" /> Paused</span>
                      ) : !usable ? (
                        <span className="status"><span className="dot bad" /> No channel</span>
                      ) : feeding.length === 0 ? (
                        <span className="status"><span className="dot bad" /> No input</span>
                      ) : importing ? (
                        <span className="status" title="Rows from the upload are still being brought in.">
                          <span className="dot ok" /> Importing
                        </span>
                      ) : active > 0 ? (
                        <span className="status"><span className="dot ok" /> Running</span>
                      ) : done > 0 ? (
                        <span className="status" title="Everyone who entered has finished. It will pick up new leads as they arrive.">
                          <span className="dot" /> Idle
                        </span>
                      ) : (
                        <span className="status" title="Set up and waiting — nobody has entered it yet.">
                          <span className="dot" /> Waiting for leads
                        </span>
                      )}
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                        {budget.touches} msg · {budget.days}d
                        <div>{sch.approvalMode === "gate_on" ? "review each" : "auto-send"}</div>
                      </div>
                    </td>

                    <td>
                      {feeding.length === 0 ? (
                        <span className="muted">nothing yet</span>
                      ) : (
                        feeding.map((src) => {
                          const health = src.health as { status?: string; error?: string } | undefined;
                          // A paused feed and a failing one both used to render as plain
                          // text, so a dead input sat here looking like a working one.
                          const progress = importOf(src);
                          const state = !src.enabled
                            ? { label: "paused", tone: "" }
                            : health?.status === "degraded"
                              ? { label: "failing", tone: "bad" }
                              : null;
                          return (
                            <div key={String(src._id)} style={{ marginBottom: 3 }}>
                              <strong style={{ fontSize: 13.5 }}>{String(src.name)}</strong>{" "}
                              {state && <span className={`pill ${state.tone}`}>{state.label}</span>}
                              <div className="muted" style={{ fontSize: 12 }}>
                                {["mcp_source", "api_pull", "crm_sync", "audience"].includes(String(src.kind))
                                  ? `every ${Math.round(Number(src.effectiveIntervalSec ?? 600) / 60)}m`
                                  : "one off"}
                              </div>
                              {progress && (
                                <div className="import">
                                  <progress value={progress.done} max={progress.total} />
                                  <span className="muted">
                                    {progress.done} of {progress.total} imported
                                    {progress.stalled ? " — stopped early" : ""}
                                  </span>
                                </div>
                              )}
                              {health?.error && (
                                <div className="muted" style={{ fontSize: 12 }}>{String(health.error)}</div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </td>

                    <td style={{ maxWidth: 260 }}>
                      <div style={{ fontSize: 13.5 }}>
                        {String((goal.success as { describedAs: string }).describedAs)}
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {checks.length > 0 ? (
                          <span className="pill ok">
                            <CircleCheck size={12} /> {checks.length} check{checks.length === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <ClaudeBadge note={goal.verifyConnectionId ? "choosing tools" : "no source picked"} />
                        )}
                      </div>
                    </td>

                    <td className="num" style={{ whiteSpace: "nowrap" }}>
                      {active} active
                      <div className="muted">{done} done</div>
                    </td>

                    {/* The column this page was missing. A campaign can collect nine clicks
                        and, without this, report exactly what a campaign that collected none
                        reports: a row of configuration. */}
                    <td>
                      <Responses
                        engagement={responses.get(String(goal.key))}
                        library={`${base}/library?campaign=${encodeURIComponent(String(goal.key))}`}
                      />
                    </td>

                    <td>
                      <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                        <GoalDrawer
                          productId={id}
                          templateKeys={templateKeys}
                          channelKeys={channelKeys}
                          toolChoices={toolChoices}
                          audiences={audiences}
                          verifiers={verifiers}
                          action={updateGoal}
                          label="Edit"
                          existing={{
                            key: String(goal.key),
                            name: String(goal.name),
                            successDescribed: String((goal.success as { describedAs: string }).describedAs),
                            verifyConnectionId: goal.verifyConnectionId ? String(goal.verifyConnectionId) : undefined,
                            firstTouchTemplate: ft.templateKey,
                            primaryChannel: ft.channels[0] ?? "email",
                            touches: budget.touches,
                            days: budget.days,
                            approvalMode: sch.approvalMode,
                          }}
                        />
                        <ActionButton
                          variant="quiet"
                          size="sm"
                          icon={paused ? <Play /> : <Pause />}
                          action={toggleGoal.bind(null, id, String(goal.key), paused)}
                          aria-label={paused ? "Resume campaign" : "Pause campaign"}
                          title={paused ? "Resume" : "Pause"}
                        />
                        <ConfirmButton
                          title={`Delete "${String(goal.name)}"?`}
                          body={
                            <>
                              This removes the campaign, its {active + done} run
                              {active + done === 1 ? "" : "s"} and anything queued but not yet sent. Messages
                              already delivered are kept — they are the record of what real people received.
                            </>
                          }
                          confirmLabel="Delete campaign"
                          action={deleteGoal.bind(null, id, String(goal.key))}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <p className="sub row" style={{ gap: 6 }}>
          <Target size={14} /> {rows.length} campaign{rows.length === 1 ? "" : "s"} ·{" "}
          {rows.reduce((n, r) => n + r.active, 0)} people in flight
        </p>
      )}
    </>
  );
}

/**
 * What a campaign earned, as against what it spent.
 *
 * Sent is the denominator and is stated first, because every other number here is
 * meaningless without it — nine clicks out of eleven sends and nine out of nine hundred
 * are different campaigns. Rates are shown only where tracking could actually have
 * reported one, so a campaign sent before tracking existed reads as unknown rather than
 * as a failure.
 */
function Responses({ engagement, library }: { engagement?: Engagement; library: string }) {
  if (!engagement || engagement.sent === 0) {
    return <span className="muted">nothing sent yet</span>;
  }

  const { sent, trackable, opened, clicked, replied, unsubscribed } = engagement;
  return (
    <div className="responses">
      <span className="status" title="Messages the provider accepted.">
        <Send size={13} className="muted" /> {sent} sent
      </span>

      <a
        className={`status ${clicked > 0 ? "live" : "muted"}`}
        href={`${library}&engagement=clicked`}
        title={trackable > 0 ? `${clicked} of ${trackable} tracked sends` : "These sends carried no tracked links."}
      >
        <MousePointerClick size={13} /> {clicked} clicked
        {trackable > 0 && <span className="muted"> · {rate(clicked, trackable)}</span>}
      </a>

      <a
        className={`status ${replied > 0 ? "live" : "muted"}`}
        href={`${library}&engagement=replied`}
        title="People in this campaign who wrote back."
      >
        <MessageSquare size={13} /> {replied} replied
      </a>

      <a
        className="status muted"
        href={`${library}&engagement=opened`}
        title="Opens are unreliable: some mail clients load images without a human looking."
      >
        <Mail size={13} /> {opened} opened
      </a>

      {unsubscribed > 0 && (
        <span className="status muted" title="They asked never to be contacted again.">
          {unsubscribed} unsubscribed
        </span>
      )}

      {/* Named rather than folded in. A link reached in a draft is nearly always our own
          testing, and quietly adding it to the click count would overstate the campaign. */}
      {engagement.preSend > 0 && (
        <span
          className="status muted"
          title="A tracking link was reached in a message that was never sent — a preview or a test, not a reader."
        >
          +{engagement.preSend} on unsent drafts
        </span>
      )}
    </div>
  );
}
