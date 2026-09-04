import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { candidatesFor, type Capability } from "@/mcp/discover.js";
import type { McpTool } from "@/mcp/client.js";
import {
  discoverTools,
  probeServer,
  reconnectWithToken,
  saveBinding,
  startReauthOAuth,
} from "../../../../actions";
import ConnectionDrawer from "../connection-drawer";
import { requireSession} from "../../../../tenant";
import { RefreshCw, Save } from "lucide-react";
import { SubmitButton } from "../../../../ui/kit";
import { ist } from "../../../../ui/time";

export const dynamic = "force-dynamic";

const VERBS = [
  { key: "send", label: "Send a message", hint: "Used by channels to deliver outbound messages." },
  { key: "fetch_leads", label: "Fetch new leads", hint: "Used by sources to pull people in." },
  {
    key: "send_status",
    label: "Check send status",
    hint: "For providers that queue rather than deliver. Binding this makes sends reconcile before being counted.",
  },
  { key: "poll_inbound", label: "Poll replies", hint: "Optional. Without it, replies cannot be detected." },
  { key: "health", label: "Health check", hint: "Optional. Used to mark the connection degraded." },
] as const;

/** Pre-fills the mapping with sensible guesses; anything wrong is corrected here. */
function guessRef(argName: string): string {
  const n = argName.toLowerCase();
  if (/^(to|recipient|email|to_email|address)$/.test(n)) return "$person.email";
  if (/subject|title/.test(n)) return "$content.subject";
  if (/html/.test(n)) return "$content.bodyHtml";
  if (/body|text|message|content/.test(n)) return "$content.body";
  if (/^from/.test(n)) return "$channel.from";
  if (/cursor|since|after|updated_since/.test(n)) return "$cursor";
  if (/batchid|jobid/.test(n)) return "$batchId";
  if (/replyto|reply_to/.test(n)) return "$channel.replyTo";
  return "";
}

export default async function ConnectionDetail({ params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  // A hand-typed or stale URL must land on Not found, not a BSON crash.
  if (!ObjectId.isValid(cid)) return <main><h1>Not found</h1></main>;
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(cid), orgId });
  if (!connection) return <main><h1>Not found</h1></main>;

  const binding = await db.collection(C.mcpBindings).findOne({ orgId: orgId, connectionId: cid });
  // Named on the page because it is the whole reason to reconnect rather than re-create.
  const [channels, sources] = await Promise.all([
    db.collection(C.channels).countDocuments({ orgId, connectionId: cid }),
    db.collection(C.sources).countDocuments({ orgId, connectionId: cid }),
  ]);
  const inUse = { channels, sources };
  const tools = (binding?.discoveredTools ?? []) as McpTool[];
  const capabilities = (binding?.capabilities ?? {}) as Record<string, Capability>;
  const bound = (binding?.bind ?? {}) as Record<string, { tool: string }>;

  return (
    <main>
      <h1>{String(connection.provider)}</h1>
      <p className="sub">
        <code>{String(connection.serverUrl)}</code> ·{" "}
        <span className={`pill ${connection.status === "healthy" ? "ok" : "warn"}`}>{String(connection.status)}</span>
      </p>

      {connection.lastError ? (
        <div className="note warn-note">
          <strong>This connection needs attention</strong>
          <p style={{ margin: "6px 0 0" }}>{String(connection.lastError)}</p>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="label">Account</div>
        <p className="sub" style={{ margin: "0 0 12px" }}>
          Authorised as <strong>{connection.account ? String(connection.account) : "an unlabelled account"}</strong>
          {connection.reconnectedAt ? ` · reconnected ${ist(connection.reconnectedAt as Date)}` : null}. Moving
          this connection to a different account replaces the credential in place, so the{" "}
          {inUse.channels} channel(s) and {inUse.sources} source(s) already pointed at it keep working.
        </p>
        <ConnectionDrawer
          productId={id}
          mode="reconnect"
          connectionId={cid}
          provider={String(connection.provider)}
          serverUrl={String(connection.serverUrl)}
          account={connection.account ? String(connection.account) : undefined}
          authType={connection.authType ? String(connection.authType) : undefined}
          oauthAction={startReauthOAuth}
          tokenAction={reconnectWithToken}
          probeAction={probeServer}
          size="md"
          label="Switch to another account"
        />
      </div>

      <form action={discoverTools.bind(null, id, cid)}>
        <SubmitButton variant="ghost" icon={<RefreshCw />} pendingLabel="Discovering…">
          {tools.length ? "Re-discover tools" : "Discover tools"}
        </SubmitButton>
      </form>

      {tools.length > 0 && (
        <>
          <h2>Discovered tools ({tools.length})</h2>
          <div className="tw">
            <table>
              <thead><tr><th>Tool</th><th>Description</th></tr></thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.name}>
                    <td><code>{t.name}</code></td>
                    <td className="muted">{t.description ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>What this connection can do</h2>
          <p className="sub">
            Read from the tool schemas. Anything unconfirmed stays off — assuming a signal exists when it does
            not would corrupt temperature scoring silently.
          </p>
          <div className="tw">
            <table>
              <thead><tr><th>Capability</th><th>Value</th><th>Source</th></tr></thead>
              <tbody>
                {Object.entries(capabilities).map(([key, cap]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>
                      <span className={`pill ${cap.value === true ? "ok" : cap.value === false ? "muted" : "warn"}`}>
                        {String(cap.value)}
                      </span>
                    </td>
                    <td className="muted">{cap.source} · {Math.round(cap.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Bind tools to actions</h2>
          {VERBS.map((verb) => {
            const candidates = candidatesFor(verb.key, tools);
            const pool = candidates.length ? candidates : tools;
            const current = bound[verb.key];
            const chosen = pool.find((t) => t.name === current?.tool) ?? pool[0];
            const props = (chosen?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};

            return (
              <div className="card" key={verb.key} style={{ marginBottom: 12 }}>
                <div className="label">{verb.label}</div>
                <p className="sub" style={{ margin: "0 0 12px" }}>
                  {verb.hint} {current && <span className="pill ok">bound to {current.tool}</span>}
                </p>
                <form action={saveBinding} className="stack">
                  <input type="hidden" name="productId" value={id} />
                  <input type="hidden" name="connectionId" value={cid} />
                  <input type="hidden" name="verb" value={verb.key} />
                  <label>
                    Tool
                    <select name="tool" defaultValue={chosen?.name}>
                      {pool.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                    </select>
                  </label>
                  {Object.keys(props).map((arg) => (
                    <label key={arg}>
                      <span>Argument <code>{arg}</code></span>
                      <input name={`arg:${arg}`} defaultValue={guessRef(arg)} placeholder="$person.email or a literal" />
                    </label>
                  ))}
                  {verb.key === "send" && (
                    <label>
                      Path to the returned message id <span className="muted">(optional)</span>
                      <input name="returnMessageId" defaultValue="$.id" />
                    </label>
                  )}
                  <SubmitButton icon={<Save />} pendingLabel="Saving…">Save binding</SubmitButton>
                </form>
              </div>
            );
          })}
        </>
      )}
    </main>
  );
}
