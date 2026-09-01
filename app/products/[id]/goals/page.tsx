import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import type { McpTool } from "@/mcp/client.js";
import { createGoal, deleteGoal } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import ClaudeBadge from "../../../ui/claude-badge";
import GoalDrawer from "./goal-drawer";

export const dynamic = "force-dynamic";

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

  const templateKeys = [...new Set(templates.map((t) => String(t.key)))];
  const channelKeys = [...new Set(channels.map((c) => String(c.key)))];

  const rows = await Promise.all(
    goals.map(async (g) => ({
      goal: g,
      active: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "active" }),
      done: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "succeeded" }),
      unplanned: await db
        .collection(C.goalInstances)
        .countDocuments({ ...s, goalKey: g.key, status: "active", currentPlanId: { $exists: false } }),
      feeding: sources.filter((src) => String(src.defaultGoalKey) === String(g.key)),
    })),
  );

  return (
    <>
      <div className="head">
        <div>
          <h1>Goals</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            A goal says what comes in, what happens the moment it does, what counts as done, and how often to
            check.
          </p>
        </div>
        <div className="spacer" />
        <GoalDrawer
          productId={id}
          templateKeys={templateKeys}
          channelKeys={channelKeys}
          toolChoices={toolChoices}
          action={createGoal}
        />
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>No goals yet</strong>
          A goal takes leads from somewhere and drives them toward something. Create the first one above.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr>
                <th>Goal</th><th>Done when</th><th>First message</th>
                <th>Input</th><th>Status</th><th>People</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ goal, active, done, unplanned, feeding }) => {
                const sch = goal.schedule as { fetchEverySec: number; approvalMode: string };
                const budget = goal.budget as { touches: number; days: number };
                const ft = goal.firstTouch as { templateKey: string; channels: string[] };
                const usable = channelKeys.some((k) => ft.channels.includes(k));

                return (
                  <tr key={String(goal._id)}>
                    <td>
                      <strong>{String(goal.name)}</strong>
                      <div className="muted" style={{ fontSize: 12.5 }}><code>{String(goal.key)}</code></div>
                    </td>
                    <td>{String((goal.success as { describedAs: string }).describedAs)}</td>
                    <td>
                      <code>{ft.templateKey}</code>
                      <div className="muted" style={{ fontSize: 12.5 }}>{ft.channels.join(" → ")}</div>
                    </td>
                    <td>
                      {feeding.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        feeding.map((src) => (
                          <div key={String(src._id)} style={{ marginBottom: 3 }}>
                            <span className={`pill ${src.enabled ? "ok" : ""}`}>{String(src.name)}</span>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {["mcp_source", "api_pull", "crm_sync"].includes(String(src.kind))
                                ? `every ${Math.round(Number(src.effectiveIntervalSec ?? 600) / 60)}m`
                                : "on arrival"}
                            </div>
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {!usable ? (
                        <span className="status"><span className="dot bad" /> no channel</span>
                      ) : feeding.length === 0 ? (
                        <span className="status"><span className="dot" /> no input</span>
                      ) : (
                        <span className="status"><span className="dot ok" /> running</span>
                      )}
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                        {budget.touches} messages · {budget.days}d ·{" "}
                        {sch.approvalMode === "gate_on" ? "review each" : "auto-send"}
                      </div>
                      {unplanned > 0 && (
                        <div style={{ marginTop: 5 }}>
                          <ClaudeBadge note={`${unplanned} awaiting a plan`} />
                        </div>
                      )}
                    </td>
                    <td className="num">
                      {active} active
                      <div className="muted">{done} done</div>
                    </td>
                    <td>
                      <ConfirmButton
                        title={`Delete "${String(goal.name)}"?`}
                        body={
                          <>
                            This removes the goal, its {active + done} run{active + done === 1 ? "" : "s"} and
                            anything queued but not yet sent. Messages already delivered are kept — they are the
                            record of what real people received.
                          </>
                        }
                        confirmLabel="Delete goal"
                        action={deleteGoal.bind(null, id, String(goal.key))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
