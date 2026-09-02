import { CircleCheck, Pause, Play, Target } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import type { McpTool } from "@/mcp/client.js";
import { audienceCount } from "@/engine/library.js";
import { createGoal, deleteGoal, toggleGoal, updateGoal } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import ClaudeBadge from "../../../ui/claude-badge";
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

  const [goals, templates, sources, connections, bindings, channels] = await Promise.all([
    db.collection(C.goals).find(s).toArray(),
    db.collection(C.templates).find({ ...s, status: "active" }).toArray(),
    db.collection(C.sources).find(s).toArray(),
    db.collection(C.connections).find({ ...s, serverUrl: { $exists: true } }).toArray(),
    db.collection(C.mcpBindings).find({ orgId }).toArray(),
    db.collection(C.channels).find({ ...s, enabled: true }).toArray(),
  ]);

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

  const rows = await Promise.all(
    goals.map(async (g) => ({
      goal: g,
      active: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "active" }),
      done: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "succeeded" }),
      feeding: sources.filter((src) => String(src.defaultGoalKey) === String(g.key)),
    })),
  );

  const awaitingPlan = rows.filter(({ goal }) => checksOf(goal).length === 0).length;

  return (
    <>
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
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ goal, active, done, feeding }) => {
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
