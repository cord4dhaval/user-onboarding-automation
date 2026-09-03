import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { channelUsage, limitsFor } from "@/engine/governor.js";
import { channelLabel } from "@/channels/catalog.js";
import type { McpTool } from "@/mcp/client.js";
import {
  createChannel,
  createHttpChannel,
  createSmtpChannel,
  deleteChannel,
  startGoogleOAuth,
  updateChannel,
} from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import ChannelDrawer from "./channel-drawer";
import ChannelSettingsDrawer from "./channel-settings";
import { WINDOW_LABEL, windowTime, type UsageWindow } from "./windows";

export const dynamic = "force-dynamic";

export default async function Channels({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [channels, connections, bindings] = await Promise.all([
    db.collection(C.channels).find(s).toArray(),
    // Every connection, not just MCP servers: a Gmail one has no server URL, and filtering
    // it out here was what left its row saying "native" under Through instead of naming it.
    db.collection(C.connections).find(s).toArray(),
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

  // One flat list of every tool on every connected server, built once: the add drawer picks
  // from it, and so does each row's edit drawer.
  const toolChoices = connectionTools.flatMap((c) =>
    c.tools.map((t) => ({
      value: `${c.id}::${t.name}`,
      label: `${c.provider} → ${t.name}`,
      description: t.description,
      args: t.args,
    })),
  );

  // Counted the same way the send path counts it, rather than read off `governor.sentToday`
  // — that counter is incremented on send and reset by nothing, so the old "23/50" on this
  // page drifted further from the truth every day and was the number people planned around.
  const usageByChannel = new Map<string, UsageWindow[]>(
    await Promise.all(
      channels.map(async (c) => {
        const channelId = String(c._id);
        const windows = await channelUsage(orgId, channelId, await limitsFor(orgId, channelId));
        return [
          channelId,
          windows.map((w) => ({ ...w, freesAt: w.freesAt?.toISOString() })),
        ] as [string, UsageWindow[]];
      }),
    ),
  );

  return (
    <>
      <div className="head">
        <div>
          <h1>Channels</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            How messages leave. Gmail connects in one click; WhatsApp and SMS are on the way. Already running your
            own sending — SMTP, an HTTP endpoint, an MCP send tool — connect that instead, on any of them.
          </p>
        </div>
        <div className="spacer" />
        <ChannelDrawer
          productId={id}
          connections={connectionTools}
          smtpAction={createSmtpChannel}
          mcpAction={createChannel}
          httpAction={createHttpChannel}
          googleAction={startGoogleOAuth}
          googleReady={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
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
              <tr><th>Channel</th><th>Through</th><th>Used</th><th>Reports back</th><th>Sends</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {channels.map((c) => {
                const caps = (c.capabilities ?? {}) as Record<string, unknown>;
                const gov = (c.governor ?? {}) as {
                  dailyCap?: number;
                  perMinute?: number;
                  perHour?: number;
                };
                const connection = connections.find((x) => String(x._id) === String(c.connectionId));
                // What this channel is bound to send with today, so the drawer opens on the
                // real mapping rather than on a fresh guess at it.
                const send = (bindingFor(String(c.connectionId))?.bind as
                  | { send?: { tool?: string; args?: Record<string, string>; returns?: { message_id?: string } } }
                  | undefined)?.send;
                const usage = usageByChannel.get(String(c._id)) ?? [];
                const daily = usage.find((w) => w.label === "daily");
                // The first limit with nothing left is the one currently stopping sends.
                const blocked = usage.find((w) => w.free === 0);
                return (
                  <tr key={String(c._id)}>
                    <td>
                      {/* The catalogue's name for it, not the raw key. "Gmail" is what the
                          customer chose; "email" is what the engine routes on. */}
                      <strong>{channelLabel(String(c.key), connection ? String(connection.provider) : undefined)}</strong>
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(c.from ?? "provider default")}</div>
                    </td>
                    <td>
                      {String(connection?.provider ?? c.kind)}
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(c.key)} · {String(c.kind)}</div>
                    </td>
                    <td>
                      {daily ? (
                        <>
                          <span className={`pill ${blocked ? "bad" : "ok"}`}>
                            {daily.used}/{daily.limit}
                          </span>
                          {/* What the number means, not what it counts. "47/50" alone reads
                              as a calendar-day tally, and this one is a rolling window that
                              refills a slot at a time — so the row says how many can go out
                              now and when the next one frees. */}
                          <div className="muted" style={{ fontSize: 12.5 }}>
                            {blocked
                              ? `${WINDOW_LABEL[blocked.label] ?? blocked.label} full${
                                  blocked.freesAt ? ` · frees ${windowTime(blocked.freesAt)}` : ""
                                }`
                              : `${daily.free} can send now`}
                          </div>
                        </>
                      ) : (
                        <span className="muted">no cap</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      {caps.trackingOpens ? "opens" : "no opens"} · {caps.inboundReplies ? "replies" : "no replies"}
                      {caps.asyncDelivery ? <div>queued, reconciled</div> : null}
                    </td>
                    <td>
                      {/* Read-only here. What a channel can carry decides what every campaign
                          on it composes, so the choice lives with the rest of the channel's
                          settings rather than as a one-click toggle on a list. */}
                      <span className={`pill ${caps.html ? "ok" : ""}`}>
                        {caps.html ? "designed email" : "plain text"}
                      </span>
                    </td>
                    <td>
                      <span className="status">
                        <span className={`dot ${c.status === "healthy" ? "ok" : "bad"}`} />
                        {String(c.status)}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <ChannelSettingsDrawer
                          channel={{
                            id: String(c._id),
                            key: String(c.key),
                            kind: String(c.kind),
                            through: connection ? String(connection.provider) : undefined,
                            from: c.from ? String(c.from) : undefined,
                            replyTo: c.replyTo ? String(c.replyTo) : undefined,
                            status: String(c.status),
                            html: Boolean(caps.html),
                            dailyCap: Number(gov.dailyCap ?? 0),
                            perMinute: gov.perMinute ?? undefined,
                            perHour: gov.perHour ?? undefined,
                            maxSubjectLength: (caps.maxSubjectLength as number | undefined) ?? undefined,
                            maxBodyLength: (caps.maxBodyLength as number | undefined) ?? undefined,
                            sendTool: send ? `${String(c.connectionId)}::${send.tool}` : undefined,
                            sendArgs: send?.args,
                            returnMessageId: send?.returns?.message_id,
                          }}
                          usage={usage}
                          toolChoices={toolChoices}
                          action={updateChannel.bind(null, id, String(c._id))}
                        />
                        <ConfirmButton
                          title={`Remove the ${String(c.key)} channel?`}
                          body="Campaigns that send on it will have nowhere to deliver until another is connected. Messages already sent are kept."
                          confirmLabel="Remove channel"
                          action={deleteChannel.bind(null, id, String(c._id))}
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
