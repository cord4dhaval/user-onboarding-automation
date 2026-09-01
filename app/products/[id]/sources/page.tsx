import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { createSource, deleteSource, runSourceNow, toggleSource } from "../../../actions";
import ConfirmButton from "../../../ui/confirm";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

/** Kinds the clock polls. The rest arrive on their own — an upload, or a webhook push. */
const POLLABLE = new Set(["mcp_source", "api_pull", "crm_sync"]);

/** Short, sortable timestamps — the table is scanned, not read. */
function stamp(value: unknown): string {
  if (!value) return "—";
  return new Date(String(value)).toISOString().slice(5, 16).replace("T", " ");
}

export default async function Sources({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [sources, connections, goals, bindings] = await Promise.all([
    db.collection(C.sources).find(s).toArray(),
    db.collection(C.connections).find({ ...s, status: "healthy" }).toArray(),
    db.collection(C.goals).find(s).toArray(),
    db.collection(C.mcpBindings).find({ orgId: orgId }).toArray(),
  ]);

  // Only a connection whose fetch tool is bound can back a source.
  const fetchable = connections.filter((c) =>
    bindings.some(
      (b) => String(b.connectionId) === String(c._id) && (b.bind as Record<string, unknown>)?.fetch_leads,
    ),
  );

  return (
    <main>
      <h1>Sources</h1>
      <p className="sub">
        Where leads come in. Each source keeps its own cursor, so two goals reading the same endpoint cannot
        double-process the same person.
      </p>

      {sources.length === 0 ? (
        <p className="empty">No sources yet.</p>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr><th>Name</th><th>Every</th><th>Goal</th><th>Last run</th><th>Next run</th><th>State</th><th /></tr>
            </thead>
            <tbody>
              {sources.map((src) => (
                <tr key={String(src._id)}>
                  <td>
                    <strong>{String(src.name)}</strong>
                    <br />
                    <span className="muted">
                      <code>{String(src.kind)}</code> · {String(src.triggerMode)}
                    </span>
                  </td>
                  <td>
                    {POLLABLE.has(String(src.kind))
                      ? `${Math.round(Number(src.effectiveIntervalSec ?? 600) / 60)} min`
                      : <span className="muted">on arrival</span>}
                  </td>
                  <td><code>{String(src.defaultGoalKey)}</code></td>
                  <td className="muted">{stamp(src.lastRunAt)}</td>
                  <td className="muted">
                    {!src.enabled ? "paused" : POLLABLE.has(String(src.kind)) ? stamp(src.nextFetchAt) : "—"}
                  </td>
                  <td>
                    <span className={`pill ${src.enabled ? "ok" : "muted"}`}>
                      {src.enabled ? "running" : "paused"}
                    </span>
                    {(src.health as { error?: string } | undefined)?.error ? (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {String((src.health as { error?: string }).error)}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <form action={runSourceNow.bind(null, id, String(src._id))} style={{ display: "inline" }}>
                      <button className="ghost" type="submit">Run now</button>
                    </form>
                    <form
                      action={toggleSource.bind(null, id, String(src._id), !src.enabled)}
                      style={{ display: "inline" }}
                    >
                      <button className="ghost" type="submit">{src.enabled ? "Pause" : "Resume"}</button>
                    </form>
                    <ConfirmButton
                      title={`Delete "${String(src.name)}"?`}
                      body="People it already brought in stay, along with their goals. Only the input is removed."
                      confirmLabel="Delete input"
                      action={deleteSource.bind(null, id, String(src._id))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Add a source</h2>
      {goals.length === 0 ? (
        <p className="empty">
          Define a <a href={`/products/${id}/goals`}>goal</a> first — a source has to point at one.
        </p>
      ) : (
        <form action={createSource} className="stack">
          <input type="hidden" name="productId" value={id} />
          <label>Name<input name="name" placeholder="TeamGrid new signups" required /></label>
          <label>
            Connection
            <select name="connectionId">
              {fetchable.length === 0 && <option value="">— none with a bound fetch tool —</option>}
              {fetchable.map((c) => (
                <option key={String(c._id)} value={String(c._id)}>{String(c.provider)}</option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select name="kind">
              <option value="mcp_source">mcp_source</option>
              <option value="api_pull">api_pull</option>
              <option value="webhook_push">webhook_push</option>
              <option value="excel_upload">excel_upload</option>
            </select>
          </label>
          <label>
            Trigger mode
            <select name="triggerMode">
              <option value="realtime">realtime — first touch ignores quiet hours</option>
              <option value="batch">batch — first touch waits for a civil hour</option>
            </select>
          </label>
          <label>Fetch interval (seconds)<input name="intervalSec" type="number" defaultValue={600} min={60} /></label>
          <label>
            Goal for new leads
            <select name="defaultGoalKey">
              {goals.map((g) => <option key={String(g.key)} value={String(g.key)}>{String(g.key)}</option>)}
            </select>
          </label>
          <label>
            Field map <span className="muted">(ours → theirs)</span>
            <textarea name="fieldMap" defaultValue={'{"email":"email","name":"name","role":"title"}'} />
          </label>
          <label>Dedupe key<input name="dedupeKey" defaultValue="email" /></label>
          <button type="submit">Create source</button>
        </form>
      )}
    </main>
  );
}
