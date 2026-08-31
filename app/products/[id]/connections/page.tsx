import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { deleteConnection } from "../../../actions";
import { scope } from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Connections({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const rows = await db.collection(C.connections).find(scope(id)).toArray();
  const bindings = await db.collection(C.mcpBindings).find({ orgId: scope(id).orgId }).toArray();
  const boundBy = new Map(bindings.map((b) => [String(b.connectionId), Object.keys((b.bind ?? {}) as object)]));

  return (
    <main>
      <h1>Connections</h1>
      <p className="sub">
        Authentication plus discovered capability. One connection can feed leads in and send messages out —
        for a product with its own MCP, that is a single setup covering both directions.
      </p>

      {rows.length === 0 ? (
        <p className="empty">
          None yet. <a href={`/products/${id}/connections/new`}>Add an MCP server</a>.
        </p>
      ) : (
        <div className="tw">
          <table>
            <thead><tr><th>Provider</th><th>Server</th><th>Bound actions</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const bound = boundBy.get(String(c._id)) ?? [];
                return (
                  <tr key={String(c._id)}>
                    <td><strong>{String(c.provider)}</strong></td>
                    <td className="muted"><code>{String(c.serverUrl ?? "—")}</code></td>
                    <td>
                      {bound.length
                        ? bound.map((v) => <span key={v} className="pill ok" style={{ marginRight: 4 }}>{v}</span>)
                        : <span className="muted">none</span>}
                    </td>
                    <td><span className={`pill ${c.status === "healthy" ? "ok" : "warn"}`}>{String(c.status)}</span></td>
                    <td>
                      <a href={`/products/${id}/connections/${String(c._id)}`}>Configure</a>
                      <form
                        action={deleteConnection.bind(null, id, String(c._id))}
                        style={{ display: "inline" }}
                      >
                        <button className="ghost danger" type="submit" style={{ marginLeft: 10 }}>
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 20 }}><a href={`/products/${id}/connections/new`}>+ New connection</a></p>
    </main>
  );
}
