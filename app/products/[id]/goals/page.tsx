import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import type { McpTool } from "@/mcp/client.js";
import InputPicker from "./input-picker";
import { createGoal, deleteGoal } from "../../../actions";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Goals({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [goals, templates, sources, connections, bindings] = await Promise.all([
    db.collection(C.goals).find(s).toArray(),
    db.collection(C.templates).find({ ...s, status: "active" }).toArray(),
    db.collection(C.sources).find(s).toArray(),
    db.collection(C.connections).find({ ...s, serverUrl: { $exists: true } }).toArray(),
    db.collection(C.mcpBindings).find({ orgId: s.orgId }).toArray(),
  ]);

  const channels = await db.collection(C.channels).find({ ...s, enabled: true }).toArray();
  const channelKeys = [...new Set(channels.map((c) => String(c.key)))];

  // One flat list of "connection → tool" so the tool can never be paired with the wrong
  // server, and no client-side JavaScript is needed to make the choice dependent.
  const toolChoices = connections.flatMap((c) => {
    const binding = bindings.find((b) => String(b.connectionId) === String(c._id));
    const tools = (binding?.discoveredTools ?? []) as McpTool[];
    return tools.map((t) => ({
      value: `${String(c._id)}::${t.name}`,
      label: `${String(c.provider)} → ${t.name}`,
      likely: /lead|contact|signup|pipeline|crm|subscriber|new_user/i.test(t.name),
    }));
  });
  toolChoices.sort((a, b) => Number(b.likely) - Number(a.likely));
  const templateKeys = [...new Set(templates.map((t) => String(t.key)))];

  const counts = await Promise.all(
    goals.map(async (g) => ({
      key: String(g.key),
      active: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "active" }),
      done: await db.collection(C.goalInstances).countDocuments({ ...s, goalKey: g.key, status: "succeeded" }),
    })),
  );

  return (
    <main>
      <h1>Goals</h1>
      <p className="sub">
        A goal says what comes in, what happens the moment it does, what counts as done, and how often to check.
      </p>

      {goals.length === 0 ? (
        <p className="empty">No goals yet. Create one below.</p>
      ) : (
        <div className="tw" style={{ marginBottom: 28 }}>
          <table>
            <thead>
              <tr>
                <th>Goal</th><th>Done when</th><th>First touch</th><th>Inputs</th>
                <th>Budget</th><th>People</th><th />
              </tr>
            </thead>
            <tbody>
              {goals.map((g) => {
                const sch = g.schedule as { fetchEverySec: number; approvalMode: string };
                const b = g.budget as { touches: number; days: number };
                const ft = g.firstTouch as { templateKey: string; channels: string[] };
                const feeding = sources.filter((src) => String(src.defaultGoalKey) === String(g.key));
                const count = counts.find((c) => c.key === String(g.key));

                return (
                  <tr key={String(g._id)}>
                    <td>
                      <strong>{String(g.name)}</strong>
                      <br />
                      <span className="muted"><code>{String(g.key)}</code></span>
                    </td>
                    <td>{String((g.success as { describedAs: string }).describedAs)}</td>
                    <td>
                      <code>{ft.templateKey}</code>
                      <br />
                      <span className="muted">{ft.channels.join(" → ")}</span>
                    </td>
                    <td>
                      {feeding.length === 0 ? (
                        <a href={`/products/${id}/sources`}>attach one</a>
                      ) : (
                        feeding.map((src) => (
                          <div key={String(src._id)}>
                            <span className={`pill ${src.enabled ? "ok" : "muted"}`}>
                              {String(src.name)}
                            </span>{" "}
                            <span className="muted">
                              every {Math.round(Number(src.effectiveIntervalSec ?? 600) / 60)}m
                            </span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="muted">
                      {b.touches} touches · {b.days}d
                      <br />
                      {sch.approvalMode === "gate_on" ? "review each" : "auto-send"}
                    </td>
                    <td>
                      {count?.active ?? 0} active
                      <br />
                      <span className="muted">{count?.done ?? 0} done</span>
                    </td>
                    <td>
                      <form action={deleteGoal.bind(null, id, String(g.key))}>
                        <button className="ghost danger" type="submit">Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>New goal</h2>
      <form action={createGoal} className="stack" encType="multipart/form-data">
        <input type="hidden" name="productId" value={id} />

        <div className="grid">
          <label>Key<input name="key" placeholder="new_user" required /></label>
          <label>Name<input name="name" placeholder="New user onboarding" required /></label>
        </div>

        <label>
          Done when <span className="muted">(plain words — what activation actually looks like)</span>
          <input name="successDescribed" defaultValue="Account created, two teammates tracked, one report opened" required />
        </label>

        <InputPicker productId={id} toolChoices={toolChoices} />

        <h3 style={{ fontSize: 15, margin: "20px 0 0" }}>What happens on arrival</h3>

        <div className="grid">
          <label>
            Send
            <select name="firstTouchTemplate">
              {templateKeys.length === 0 && <option value="welcome">welcome</option>}
              {templateKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label>
            Via
            <select name="primaryChannel" defaultValue={channelKeys[0] ?? "email"}>
              {channelKeys.length === 0 && <option value="email">email</option>}
              {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>

        <div className="grid">
          <label>
            If that is unavailable <span className="muted">(optional fallback)</span>
            <select name="fallbackChannel" defaultValue="">
              <option value="">— none —</option>
              {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>

        <div className="grid">
          <label>Max touches<input name="touches" type="number" defaultValue={9} /></label>
          <label>Max days<input name="days" type="number" defaultValue={30} /></label>
          <label>
            Before sending
            <select name="approvalMode" defaultValue="gate_on">
              <option value="gate_on">Hold each for review</option>
              <option value="auto_send">Send automatically</option>
            </select>
          </label>
        </div>

        <details>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Advanced</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <label>
              Field map <span className="muted">(ours → theirs; left blank it is guessed from the headers)</span>
              <textarea name="fieldMap" placeholder='{"email":"Email","name":"Name","role":"Title"}' />
            </label>
            <label>Dedupe on<input name="dedupeKey" defaultValue="email" /></label>
            <label>
              Success expression <span className="muted">(evaluated against product events)</span>
              <input name="successExpression" defaultValue="account_created AND teammates_invited >= 2 AND report_viewed >= 1" />
            </label>
            <div className="grid">
              <label>Spend cap ($)<input name="usd" type="number" defaultValue={12} /></label>
              <label>Tick every (s)<input name="tickEverySec" type="number" defaultValue={600} /></label>
              <label>Give up after (days silent)<input name="silenceDays" type="number" defaultValue={30} /></label>
            </div>
          </div>
        </details>

        <button type="submit">Create goal</button>
      </form>
    </main>
  );
}
