import { Settings2 } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import {
  createConnection,
  deleteConnection,
  probeServer,
  reconnectWithToken,
  startOAuth,
  startReauthOAuth,
} from "../../../actions";
import ConfirmButton from "../../../ui/confirm";
import ConnectionDrawer from "./connection-drawer";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Connections({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // A link elsewhere can arrive here meaning to connect something — brand does exactly
  // that, carrying the provider's MCP URL with it.
  searchParams: Promise<{ connect?: string; serverUrl?: string }>;
}) {
  const { id } = await params;
  const { connect, serverUrl } = await searchParams;
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
        <ConnectionDrawer
          productId={id}
          mode="create"
          serverUrl={serverUrl}
          openOnMount={connect === "1"}
          oauthAction={startOAuth}
          tokenAction={createConnection}
          probeAction={probeServer}
        />
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>Nothing connected</strong>
          A connection is where leads come from, where messages go, and what answers whether someone
          succeeded. Add an MCP server with the button above.
        </div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr><th>Provider</th><th>Server</th><th>Account</th><th>Bound actions</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const bound = boundBy.get(String(c._id)) ?? [];
                return (
                  <tr key={String(c._id)}>
                    <td><strong>{String(c.provider)}</strong></td>
                    <td className="muted"><code>{String(c.serverUrl ?? "—")}</code></td>
                    <td>
                      {c.account ? String(c.account) : <span className="muted">unlabelled</span>}
                    </td>
                    <td>
                      {bound.length
                        ? bound.map((v) => <span key={v} className="pill ok" style={{ marginRight: 4 }}>{v}</span>)
                        : <span className="muted">none</span>}
                    </td>
                    <td>
                      <span className={`pill ${c.status === "healthy" ? "ok" : "warn"}`}>{String(c.status)}</span>
                      {/* Why it is not healthy belongs next to the word, not one click away. */}
                      {c.lastError ? <div className="reason">{String(c.lastError)}</div> : null}
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                        <a className="btn ghost sm" href={`/products/${id}/connections/${String(c._id)}`}>
                          <Settings2 /> Configure
                        </a>
                        <ConnectionDrawer
                          productId={id}
                          mode="reconnect"
                          connectionId={String(c._id)}
                          provider={String(c.provider)}
                          serverUrl={c.serverUrl ? String(c.serverUrl) : undefined}
                          account={c.account ? String(c.account) : undefined}
                          authType={c.authType ? String(c.authType) : undefined}
                          oauthAction={startReauthOAuth}
                          tokenAction={reconnectWithToken}
                          probeAction={probeServer}
                        />
                        <ConfirmButton
                          title={`Disconnect ${String(c.provider)}?`}
                          body="The stored credential and the tool bindings go with it, and anything pointed at this connection has to be rewired. To hand it to a different account, use Switch account instead — that keeps the bindings."
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
