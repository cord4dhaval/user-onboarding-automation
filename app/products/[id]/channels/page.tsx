import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import type { McpTool } from "@/mcp/client.js";
import { createChannel, createHttpChannel, createSmtpChannel, deleteChannel, setChannelHtml } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import { SubmitButton } from "../../../ui/kit";
import ChannelDrawer from "./channel-drawer";

export const dynamic = "force-dynamic";

export default async function Channels({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [channels, connections, bindings] = await Promise.all([
    db.collection(C.channels).find(s).toArray(),
    db.collection(C.connections).find({ ...s, serverUrl: { $exists: true } }).toArray(),
    db.collection(C.mcpBindings).find({ orgId }).toArray(),
  ]);

  const bindingFor = (connectionId: string) =>
    bindings.find((b) => String(b.connectionId) === connectionId);

  // Every connection with its full tool list. Nothing is filtered or ranked — guessing
  // which tool sends was worse than asking, because "mail" appears inside "email" and the
  // readers outranked the sender.
  const connectionTools = connections
    .map((c) => {
      const binding = bindingFor(String(c._id));
      const tools = (binding?.discoveredTools ?? []) as McpTool[];
      return {
        id: String(c._id),
        provider: String(c.provider),
        serverUrl: String(c.serverUrl),
        boundSendTool: (binding?.bind as Record<string, { tool?: string }> | undefined)?.send?.tool,
        tools: tools.map((t) => {
          const schema = t.inputSchema as
            | { properties?: Record<string, { type?: unknown; description?: string }>; required?: string[] }
            | undefined;
          const properties = schema?.properties ?? {};
          const required = new Set((schema?.required ?? []).map(String));
          const args = Object.entries(properties).map(([name, spec]) => ({
            name,
            required: required.has(name),
            type: Array.isArray(spec?.type)
              ? spec.type.map(String).join(" or ")
              : typeof spec?.type === "string"
                ? spec.type
                : undefined,
            description: typeof spec?.description === "string" ? spec.description : undefined,
          }));
          // What the tool insists on comes first: those are the fields that decide whether
          // this channel can send at all.
          args.sort((a, b) => Number(b.required) - Number(a.required));
          return { name: t.name, description: t.description, args };
        }),
      };
    })
    .filter((c) => c.tools.length > 0);

  return (
    <>
      <div className="head">
        <div>
          <h1>Channels</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            How messages leave. Three ways, and any channel type can use whichever fits: your own mail account
            over SMTP, an MCP connection whose send tool you bound, or any provider with an HTTP endpoint and a
            token.
          </p>
        </div>
        <div className="spacer" />
        <ChannelDrawer
          productId={id}
          connections={connectionTools}
          smtpAction={createSmtpChannel}
          mcpAction={createChannel}
          httpAction={createHttpChannel}
        />
      </div>

      {channels.length === 0 ? (
        <div className="empty">
          <strong>No channel yet</strong>
          Campaigns will create people and queue messages that never leave. Add one above.
          {connectionTools.length > 0 && (
            <p style={{ margin: "10px 0 0" }}>
              {connectionTools.map((c) => `${c.provider} (${c.tools.length} tools)`).join(" · ")} — pick the one
              that sends when you add the channel.
            </p>
          )}
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr><th>Channel</th><th>Through</th><th>Today</th><th>Reports back</th><th>Sends</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {channels.map((c) => {
                const caps = (c.capabilities ?? {}) as Record<string, unknown>;
                const gov = (c.governor ?? {}) as { sentToday?: number; dailyCap?: number };
                const connection = connections.find((x) => String(x._id) === String(c.connectionId));
                return (
                  <tr key={String(c._id)}>
                    <td>
                      <strong>{String(c.key)}</strong>
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(c.from ?? "provider default")}</div>
                    </td>
                    <td>
                      {String(connection?.provider ?? c.kind)}
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(c.kind)}</div>
                    </td>
                    <td className="num">{gov.sentToday ?? 0}/{gov.dailyCap ?? "—"}</td>
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      {caps.trackingOpens ? "opens" : "no opens"} · {caps.inboundReplies ? "replies" : "no replies"}
                      {caps.asyncDelivery ? <div>queued, reconciled</div> : null}
                    </td>
                    <td>
                      {/* Whether a channel can carry a designed email decides what every
                          campaign on it sends, so it is worth being able to correct by
                          hand rather than only by rediscovery. */}
                      <form action={setChannelHtml.bind(null, id, String(c._id))} className="row">
                        <input type="hidden" name="html" value={caps.html ? "false" : "true"} />
                        <span className={`pill ${caps.html ? "ok" : ""}`}>
                          {caps.html ? "designed email" : "plain text"}
                        </span>
                        <SubmitButton variant="ghost" size="sm" pendingLabel="Saving…">
                          {caps.html ? "Send as plain text" : "Allow designed email"}
                        </SubmitButton>
                      </form>
                    </td>
                    <td>
                      <span className="status">
                        <span className={`dot ${c.status === "healthy" ? "ok" : "bad"}`} />
                        {String(c.status)}
                      </span>
                    </td>
                    <td>
                      <ConfirmButton
                        title={`Remove the ${String(c.key)} channel?`}
                        body="Campaigns that send on it will have nowhere to deliver until another is connected. Messages already sent are kept."
                        confirmLabel="Remove channel"
                        action={deleteChannel.bind(null, id, String(c._id))}
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
