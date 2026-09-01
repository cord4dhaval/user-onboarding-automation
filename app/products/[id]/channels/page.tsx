import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { createChannel, createSmtpChannel, deleteChannel } from "../../../actions";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Channels({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [channels, connections, bindings] = await Promise.all([
    db.collection(C.channels).find(s).toArray(),
    db.collection(C.connections).find({ ...s, status: "healthy" }).toArray(),
    db.collection(C.mcpBindings).find({ orgId: orgId }).toArray(),
  ]);

  // Only a connection whose send tool is bound can carry a channel.
  const sendable = connections.filter((c) =>
    bindings.some((b) => String(b.connectionId) === String(c._id) && (b.bind as Record<string, unknown>)?.send),
  );

  return (
    <main>
      <h1>Channels</h1>
      <p className="sub">
        How messages go out. Either over SMTP with your own mail account, or through an MCP connection whose
        send tool you bound — a product MCP that can send is both your channel and your source at once.
      </p>

      {channels.length === 0 ? (
        <p className="empty">No channels yet.</p>
      ) : (
        <div className="tw">
          <table>
            <thead><tr><th>Channel</th><th>From</th><th>Today</th><th>Reports back</th><th>Status</th><th /></tr></thead>
            <tbody>
              {channels.map((c) => {
                const caps = c.capabilities as Record<string, unknown>;
                const gov = c.governor as { sentToday: number; dailyCap: number };
                return (
                  <tr key={String(c._id)}>
                    <td><strong>{String(c.key)}</strong> <span className="muted">{String(c.kind)}</span></td>
                    <td className="muted">{String(c.from ?? "provider default")}</td>
                    <td>{gov.sentToday}/{gov.dailyCap}</td>
                    <td className="muted">
                      {caps.trackingOpens ? "opens" : "no opens"} · {caps.inboundReplies ? "replies" : "no replies"}
                      {caps.asyncDelivery ? " · queued, reconciled" : ""}
                    </td>
                    <td><span className={`pill ${c.status === "healthy" ? "ok" : "warn"}`}>{String(c.status)}</span></td>
                    <td>
                      <form action={deleteChannel.bind(null, id, String(c._id))}>
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

      <h2>Add a channel</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="label">Email over SMTP</div>
        <p className="sub" style={{ margin: "0 0 12px" }}>
          Use this when the product&apos;s MCP has no send tool — the common case, since most product MCPs are
          read surfaces. Works with any SMTP: Gmail app password, Zoho, Brevo, your own server. The password is
          encrypted on arrival and never shown again.
        </p>
        <form action={createSmtpChannel} className="stack">
          <input type="hidden" name="productId" value={id} />
          <label>Name<input name="provider" defaultValue="smtp" /></label>
          <div className="grid">
            <label>Host<input name="host" placeholder="smtp.gmail.com" required /></label>
            <label>Port<input name="port" type="number" defaultValue={587} /></label>
          </div>
          <label>Username<input name="user" placeholder="you@yourdomain.com" required /></label>
          <label>Password<input name="pass" type="password" placeholder="app password" required /></label>
          <label>From<input name="from" placeholder="TeamGrid &lt;hi@yourdomain.com&gt;" required /></label>
          <label>Daily cap<input name="dailyCap" type="number" defaultValue={50} min={1} /></label>
          <button type="submit">Create email channel</button>
        </form>
      </div>

      <h3 style={{ fontSize: 15, margin: "24px 0 8px" }}>Or from an MCP connection</h3>
      {sendable.length === 0 ? (
        <p className="empty">
          No connection has a send tool bound. Neither TeamGrid nor Brandgrid exposes one — use SMTP above.
        </p>
      ) : (
        <form action={createChannel} className="stack">
          <input type="hidden" name="productId" value={id} />
          <label>
            Connection
            <select name="connectionId">
              {sendable.map((c) => (
                <option key={String(c._id)} value={String(c._id)}>
                  {String(c.provider)} — {String(c.serverUrl)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Channel
            <select name="key">
              <option value="email">email</option>
              <option value="whatsapp">whatsapp</option>
              <option value="sms">sms</option>
              <option value="in_app">in_app</option>
            </select>
          </label>
          <label>
            From <span className="muted">(leave blank if the provider controls it)</span>
            <input name="from" placeholder="TeamGrid &lt;hi@teamgrid.ai&gt;" />
          </label>
          <label>
            Reply-To <span className="muted">(where replies should land)</span>
            <input name="replyTo" placeholder="hello@teamgrid.ai" />
          </label>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Provider limits. Take these from the tool&apos;s own documentation — the engine enforces them before
            every send, so a message is never rejected for exceeding a cap it could have checked.
          </p>
          <div className="grid">
            <label>Per minute<input name="perMinute" type="number" placeholder="20" /></label>
            <label>Per hour<input name="perHour" type="number" placeholder="100" /></label>
            <label>Daily cap<input name="dailyCap" type="number" defaultValue={50} min={1} /></label>
          </div>
          <div className="grid">
            <label>Max subject chars<input name="maxSubjectLength" type="number" placeholder="200" /></label>
            <label>Max body chars<input name="maxBodyLength" type="number" placeholder="20000" /></label>
          </div>
          <button type="submit">Create channel</button>
        </form>
      )}
    </main>
  );
}
