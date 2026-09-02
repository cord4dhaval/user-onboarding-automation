import { Plus, Settings2 } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { deleteConnection } from "../../../actions";
import ConfirmButton from "../../../ui/confirm";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Connections({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const rows = await db.collection(C.connections).find(scope(orgId, id)).toArray();
  const bindings = await db.collection(C.mcpBindings).find({ orgId: scope(orgId, id).orgId }).toArray();
  const boundBy = new Map(bindings.map((b) => [String(b.connectionId), Object.keys((b.bind ?? {}) as object)]));

  return (
    <>
      <div className="head">
        <div>
          <h1>Connections</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Authentication plus discovered capability. One connection can feed leads in and send messages out —
            for a product with its own MCP, that is a single setup covering both directions.
          </p>
        </div>
        <div className="spacer" />
        <a className="btn" href={`/products/${id}/connections/new`}><Plus /> New connection</a>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>Nothing connected</strong>
          A connection is where leads come from, where messages go, and what answers whether someone
          succeeded. <a href={`/products/${id}/connections/new`}>Add an MCP server</a>.
        </div>
      ) : (
        <div className="tw">
          <table>
            <thead><tr><th>Provider</th><th>Server</th><th>Bound actions</th><th>Status</th><th /></tr></thead>
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
                      <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                        <a className="btn ghost sm" href={`/products/${id}/connections/${String(c._id)}`}>
                          <Settings2 /> Configure
                        </a>
                        <ConfirmButton
                          title={`Disconnect ${String(c.provider)}?`}
                          body="The stored credential and the tool bindings go with it. Reconnecting means authorising again from scratch."
                          confirmLabel="Disconnect"
                          action={deleteConnection.bind(null, id, String(c._id))}
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

    </>
  );
}
