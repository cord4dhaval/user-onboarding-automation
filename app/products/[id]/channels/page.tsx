import type { ReactNode } from "react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { channelUsage, limitsFor } from "@/engine/governor.js";
import { catalogById, channelLabel, CHANNEL_CATALOG } from "@/channels/catalog.js";
import type { McpTool } from "@/mcp/client.js";
import {
  connectSesDomain,
  createChannel,
  createHttpChannel,
  createSmtpChannel,
  deleteChannel,
  setChannelEnabled,
  recheckSesDomain,
  restartSesDomain,
  startGoogleOAuth,
  updateChannel,
} from "../../../actions";
import { grantedCapabilities } from "@/auth/google.js";
import SesRecords from "./ses-records";
import { requireSession, scope } from "../../../tenant";
import ConfirmButton from "../../../ui/confirm";
import { ActionButton } from "../../../ui/kit";
import { Power, PowerOff } from "lucide-react";
import ChannelCards from "./channel-cards";
import ChannelSettingsDrawer from "./channel-settings";
import { WINDOW_LABEL, windowTime, type UsageWindow } from "./windows";

export const dynamic = "force-dynamic";

/**
 * What a failed sign-in actually was.
 *
 * Google sends the browser back here with a code in the query string and nothing rendered
 * it, so a consent screen that went wrong looked exactly like one that was never opened —
 * the card sat there saying Connect and the reason was only in the URL.
 */
const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "You cancelled on Google's screen, so nothing was connected. Nothing was stored either.",
  send_permission_declined:
    "The send permission was left unticked on Google's screen, so this mailbox could not send anything. Connect again and leave every box ticked.",
  no_refresh_token:
    "Google issued no refresh token because this account had already granted access, and the connection would have died within the hour. Remove this app's access at myaccount.google.com, then connect again.",
  missing_code: "Google came back without a usable code. Start the sign-in again.",
  unknown_state: "That sign-in had already been finished or expired. Start it again.",
};

export default async function Channels({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const oauthError = (await searchParams)?.oauth_error;
  const failed = Array.isArray(oauthError) ? oauthError[0] : oauthError;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [channels, connections, bindings, assignedRows] = await Promise.all([
    db.collection(C.channels).find(s).toArray(),
    // Every connection, not just MCP servers: a Gmail one has no server URL, and filtering
    // it out here was what left its row saying "native" under Through instead of naming it.
    db.collection(C.connections).find(s).toArray(),
    db.collection(C.mcpBindings).find({ orgId }).toArray(),
    // How many people each mailbox is currently the sender for. A daily count says how busy
    // a channel was this morning; this says how much of the product is depending on it, which
    // is the number that matters when someone is deciding whether to switch it off.
    db
      .collection(C.people)
      .aggregate([{ $match: s }, { $group: { _id: "$assignedChannelId", n: { $sum: 1 } } }])
      .toArray(),
  ]);

  const assignedByChannel = new Map(assignedRows.map((r) => [String(r._id), Number(r.n)]));

  const bindingFor = (connectionId: string) =>
    bindings.find((b) => String(b.connectionId) === connectionId);

  // Google accounts that could be the inbox for a domain that sends through SES. The read
  // permission is carried rather than filtered on, so the drawer can tell "connect Gmail"
  // apart from "the Gmail you connected cannot read replies" — two different fixes.
  const mailboxes = connections
    .filter((c) => c.authType === "oauth2" && c.provider === "google")
    .map((c) => ({
      id: String(c._id),
      email: String(c.accountEmail ?? "this account"),
      canRead: grantedCapabilities((c.scopes ?? []) as string[]).read,
    }));

  // Connections whose server actually hands out mailbox tokens, which is what decides
  // whether replies get read — not the capability flag stamped on the channel at creation.
  const reads = new Set(
    connections
      .filter((c) => {
        // An MCP server reads replies if it offers the tool for it.
        if (
          ((bindingFor(String(c._id))?.discoveredTools ?? []) as McpTool[]).some(
            (t) => String(t.name) === "get_email_tokens",
          )
        ) {
          return true;
        }
        // A Gmail mailbox reads them through the Gmail API, on the scope its owner granted
        // — it has no MCP tools at all. Tested only for the tool, this said "cannot read
        // replies" on every mailbox connected by signing in, including ones the inbound
        // poller has been reading every ten minutes. The card was wrong, not the mailbox.
        return (
          c.authType === "oauth2" &&
          c.provider === "google" &&
          grantedCapabilities((c.scopes ?? []) as string[]).read
        );
      })
      .map((c) => String(c._id)),
  );

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

  // One flat list of every tool on every connected server, built once: the connect drawer
  // picks from it, and so does each channel's edit drawer.
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

  /** One connected channel, as it reads inside its card: what it sends as, what it has
   * spent, what it reports back, and both ways of changing it. */
  function connectedChannel(c: Record<string, unknown>): ReactNode {
    const caps = (c.capabilities ?? {}) as Record<string, unknown>;
    const gov = (c.governor ?? {}) as { dailyCap?: number; perMinute?: number; perHour?: number };
    const connection = connections.find((x) => String(x._id) === String(c.connectionId));
    // What this channel is bound to send with today, so the drawer opens on the real
    // mapping rather than on a fresh guess at it.
    const send = (bindingFor(String(c.connectionId))?.bind as
      | { send?: { tool?: string; args?: Record<string, string>; returns?: { message_id?: string } } }
      | undefined)?.send;
    const usage = usageByChannel.get(String(c._id)) ?? [];
    const audience = ((c.policy as { audience?: string[] } | undefined)?.audience ?? []) as string[];
    const assigned = assignedByChannel.get(String(c._id)) ?? 0;
    // One word for both flags. They are written together and mean nothing apart: a channel
    // the planner skips but the send path would still use is not a state anyone wants.
    const live = c.status === "healthy" && c.enabled !== false;
    const daily = usage.find((w) => w.label === "daily");
    // The first limit with nothing left is the one currently stopping sends.
    const blocked = usage.find((w) => w.free === 0);

    return (
      <div className={`channel-conn${live ? "" : " is-off"}`} key={String(c._id)}>
        {/* Sender first, switch last, on one line. The address is what someone came to the
            page to read; the switch is what they came to change. Everything between them
            used to sit above both. */}
        <div className="channel-line channel-top">
          <span className={`dot ${live ? "ok" : "bad"}`} />
          <strong>{String(c.from ?? "provider default sender")}</strong>
          <ActionButton
            action={setChannelEnabled.bind(null, id, String(c._id), !live)}
            variant="quiet"
            size="sm"
            icon={live ? <Power /> : <PowerOff />}
            pendingLabel={live ? "Switching off…" : "Switching on…"}
            toast={{
              tone: live ? "info" : "good",
              title: live ? `${String(c.from ?? "Channel")} switched off` : `${String(c.from ?? "Channel")} switched on`,
              body: live
                ? "Nothing new will be planned onto it, and nothing queued on it will send."
                : "It can be planned onto and can send again.",
            }}
          >
            {live ? "On" : "Off"}
          </ActionButton>
        </div>

        {/* Five rows of loose pills became a labelled grid.
            Every value here answers a different question — who it writes to, how many
            people it speaks for, what it has spent, what it can carry, what it goes
            through — and as bare pills they read as one undifferentiated cloud where the
            only way to tell "cold" from "designed email" was already knowing. */}
        <dl className="channel-facts">
          <dt>Writes to</dt>
          <dd>
            {audience.length > 0 ? (
              audience.map((a) => (
                <span className="pill" key={a}>
                  {a.replace("_", " ")}
                </span>
              ))
            ) : (
              <span className="pill bad">nobody</span>
            )}
          </dd>

          <dt>Assigned</dt>
          <dd>
            {assigned} {assigned === 1 ? "lead" : "leads"}
          </dd>

          <dt>Sent today</dt>
          <dd>
            {daily ? (
              <>
                <span className={`pill ${blocked ? "bad" : "ok"}`}>
                  {daily.used}/{daily.limit}
                </span>
                {/* What the number means, not what it counts. "47/50" alone reads as a
                    calendar-day tally, and this one is a rolling window that refills a
                    slot at a time. */}
                <span className="muted">
                  {blocked
                    ? `${WINDOW_LABEL[blocked.label] ?? blocked.label} full${
                        blocked.freesAt ? ` · frees ${windowTime(blocked.freesAt)}` : ""
                      }`
                    : `${daily.free} can send now`}
                </span>
              </>
            ) : (
              <span className="pill">no cap</span>
            )}
          </dd>

          <dt>Carries</dt>
          <dd>
            {/* Read-only here. What a channel can carry decides what every campaign on it
                composes, so the choice lives in its settings rather than as a list toggle. */}
            <span className="muted">
              {caps.html ? "designed email" : "plain text"} ·{" "}
              {caps.trackingOpens ? "opens" : "no opens"} ·{" "}
              {/* What the channel reports, as against what it was recorded as reporting.
                  `inboundReplies` is set when the channel is created and never revisited,
                  and it said "no replies" on a connection whose server does offer the
                  mailbox tool and whose replies have been read every ten minutes since.
                  The discovered tool list is the fact; the stored flag was a guess. */}
              {reads.has(String(c.connectionId)) ? "reads replies" : "cannot read replies"}
              {caps.asyncDelivery ? " · queued, reconciled" : ""}
            </span>
          </dd>

          <dt>Through</dt>
          <dd>
            {/* Named honestly: a card headed Gmail can hold an SMTP or endpoint channel on
                the same key, and it should say so rather than borrow the vendor's name. */}
            <span className="muted">
              {channelLabel(String(c.key), connection ? String(connection.provider) : undefined)} ·{" "}
              {String(connection?.provider ?? c.kind)} · {String(c.kind)}
            </span>
          </dd>
        </dl>

        {/* A domain that has not verified is the reason this channel is not sending, so the
            records sit on the card itself rather than behind an edit drawer. */}
        {connection?.authType === "ses" && (
          <SesRecords
            domain={String((connection.ses as { domain?: string })?.domain ?? "")}
            status={
              ((connection.ses as { status?: string })?.status ?? "pending") as "pending" | "verified" | "failed"
            }
            records={((connection.ses as { records?: unknown[] })?.records ?? []) as never}
            checksUntil={
              (connection.ses as { checksUntil?: Date })?.checksUntil
                ? new Date((connection.ses as { checksUntil: Date }).checksUntil).toISOString()
                : undefined
            }
            recheckAction={recheckSesDomain.bind(null, id, String(connection._id))}
            restartAction={restartSesDomain.bind(null, id, String(connection._id))}
          />
        )}

        {/* Why the engine is refusing to send on it, in the words the health check used.
            A degraded channel with no stated reason is the thing people file bugs about. */}
        {Array.isArray(c.healthReasons) && c.healthReasons.length > 0 && (
          <ul className="channel-meta">
            {(c.healthReasons as string[]).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}

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
              audience,
              assignedLeads: assigned,
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
      </div>
    );
  }

  /**
   * Which card a channel belongs under: the catalogue entry its connection's provider names,
   * falling back to the entry that owns its key. A channel on a key the catalogue does not
   * carry — in_app, push, or anything created before the catalogue existed — is grouped
   * apart rather than dropped, because a channel that stops being drawn keeps sending.
   */
  const connected: Record<string, ReactNode[]> = {};
  const other: ReactNode[] = [];
  for (const c of channels) {
    const provider = connections.find((x) => String(x._id) === String(c.connectionId))?.provider;
    const option =
      (provider ? catalogById(String(provider)) : undefined) ??
      CHANNEL_CATALOG.find((o) => o.channelKey === String(c.key));
    const node = connectedChannel(c);
    if (option) (connected[option.id] ??= []).push(node);
    else other.push(node);
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Channels</h1>
          <p className="sub tight">
            How messages leave. Pick a channel below to connect it. Gmail connects in one click; WhatsApp and SMS
            are not live natively yet. Already running your own sending — SMTP, an HTTP endpoint, an MCP send
            tool — connect that instead, on any of them.
          </p>
        </div>
      </div>

      {failed && (
        <div className="note bad">
          <p>
            <strong>That sign-in did not connect a channel.</strong> {OAUTH_ERRORS[failed] ?? failed}
          </p>
        </div>
      )}

      {channels.length === 0 && (
        <div className="note">
          <p>
            No channel is connected yet, so campaigns will create people and queue messages that never leave.
            Connect one below.
            {connectionTools.length > 0 &&
              ` ${connectionTools
                .map((c) => `${c.provider} (${c.tools.length} tools)`)
                .join(" · ")} — already connected, and can be the sender.`}
          </p>
        </div>
      )}

      <ChannelCards
        productId={id}
        connections={connectionTools}
        connected={connected}
        other={other}
        googleReady={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
        sesReady={Boolean(
          process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
        )}
        mailboxes={mailboxes}
        smtpAction={createSmtpChannel}
        mcpAction={createChannel}
        httpAction={createHttpChannel}
        googleAction={startGoogleOAuth}
        sesAction={connectSesDomain}
      />
    </>
  );
}
