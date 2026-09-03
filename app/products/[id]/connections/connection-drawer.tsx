"use client";

import { useState } from "react";
import { Plug, Plus, RefreshCw, Search, ShieldCheck } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";

type Probe = { oauth: boolean; dcr: boolean; error?: string };

/**
 * One panel for both halves of a connection's life: adding it, and moving it to a
 * different account.
 *
 * They ask the same questions — which server, which account, OAuth or a token — so they
 * are the same form with the fixed parts filled in. Adding used to be a page of its own,
 * which meant leaving the list to do the thing the list is about.
 */
export default function ConnectionDrawer({
  productId,
  mode,
  connectionId,
  provider,
  serverUrl,
  account,
  authType,
  oauthAction,
  tokenAction,
  probeAction,
  openOnMount = false,
  size = "sm",
  label,
}: {
  productId: string;
  mode: "create" | "reconnect";
  /** Reconnect only — the connection whose credential is being replaced. */
  connectionId?: string;
  provider?: string;
  serverUrl?: string;
  account?: string;
  authType?: string;
  /** create: startOAuth · reconnect: startReauthOAuth */
  oauthAction: (formData: FormData) => void | Promise<void>;
  /** create: createConnection · reconnect: reconnectWithToken */
  tokenAction: (formData: FormData) => void | Promise<void>;
  probeAction: (serverUrl: string) => Promise<Probe>;
  /** Opens straight away, for links that arrive here meaning to connect something. */
  openOnMount?: boolean;
  size?: "sm" | "md";
  label?: string;
}) {
  const creating = mode === "create";
  const [open, setOpen] = useState(openOnMount);
  const [method, setMethod] = useState(authType === "mcp_bearer" ? "token" : "oauth");
  const [url, setUrl] = useState(serverUrl ?? "");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  // Asking the server what it supports before committing to a path is the whole point of
  // the check — a token pasted into a server that speaks OAuth is a worse setup, and a
  // consent screen that does not exist is a dead end.
  async function check() {
    if (!url.trim()) return;
    setProbing(true);
    try {
      setProbe(await probeAction(url.trim()));
    } catch (err) {
      setProbe({ oauth: false, dcr: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbing(false);
    }
  }

  /** The server URL, editable when adding and fixed when reconnecting. */
  const serverField = creating ? (
    <>
      <label>
        Server URL
        <input
          name="serverUrl"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.teamgrid.ai/mcp"
          required
        />
      </label>
      <div className="row">
        {/* Inside a form, so it must say it is not the submit. */}
        <Button type="button" variant="ghost" size="sm" icon={<Search />} loading={probing} onClick={check}>
          {probing ? "Checking…" : "Check what this server supports"}
        </Button>
      </div>
      {probe && (
        <div className="note">
          {probe.error ? (
            <span>{probe.error}</span>
          ) : (
            <>
              OAuth:{" "}
              {probe.oauth ? (
                <span className="pill ok">supported</span>
              ) : (
                <span className="pill warn">not advertised — use an access token</span>
              )}
              {probe.oauth && (
                <>
                  {" · "}Automatic client registration:{" "}
                  {probe.dcr ? (
                    <span className="pill ok">supported</span>
                  ) : (
                    <span className="pill warn">not supported — you will need a client ID</span>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  ) : (
    <input type="hidden" name="connectionId" value={connectionId} />
  );

  return (
    <>
      <Button
        variant={creating ? "primary" : "quiet"}
        size={creating ? "md" : size}
        icon={creating ? <Plus /> : <RefreshCw />}
        onClick={() => setOpen(true)}
      >
        {label ?? (creating ? "New connection" : "Switch account")}
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={creating ? "Connect an MCP server" : `Reconnect ${provider}`}
        description={
          creating
            ? "One connection can pull leads in and send messages out. The secret is encrypted on arrival and never shown again."
            : "Same connection, a different account. Channels, sources and tool bindings stay pointed here."
        }
      >
        <div className="stack">
          {creating ? (
            <div className="note">
              Whichever way you authorise, the next screen lists the server&apos;s tools and you choose which one
              sends and which one returns leads. Nothing is bound automatically — a wrong guess about which tool
              sends mail is expensive.
            </div>
          ) : (
            <div className="note">
              Connected as <strong>{account || "an unlabelled account"}</strong>. Authorising again replaces that
              credential — the old one stops being used the moment the new one is stored, and is not kept.
            </div>
          )}

          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="oauth">
                {creating ? "OAuth — approve on the provider's own screen" : "OAuth — sign in as the new account"}
              </option>
              <option value="token">
                {creating ? "Access token — paste a bearer token" : "Access token — paste the new account's token"}
              </option>
            </select>
          </label>

          {method === "oauth" ? (
            <form action={oauthAction} className="stack">
              <input type="hidden" name="productId" value={productId} />
              {creating && <label>Name<input name="provider" defaultValue={provider} placeholder="teamgrid" required /></label>}
              {serverField}
              <label>
                {creating ? "Account label" : "Connect as"}{" "}
                <span className="muted">(who this will be, for the connections list)</span>
                <input name="account" placeholder="user-y@company.com" />
              </label>
              <label>
                Client ID <span className="muted">(only if the server has no automatic registration)</span>
                <input
                  name="clientId"
                  placeholder={creating ? "leave blank to register automatically" : "leave blank to reuse the existing registration"}
                />
              </label>
              <label>
                Client secret <span className="muted">(only if the provider issued one)</span>
                <input name="clientSecret" type="password" placeholder="usually not needed" />
              </label>
              <p className="sub">
                {creating
                  ? "You approve on the provider's own consent screen. We never see a password, the token refreshes itself, and access can be revoked from their side."
                  : "You will be asked to sign in again rather than being let through on the session already open, so the account that comes back is the one you chose."}
              </p>
              <SubmitButton icon={<ShieldCheck />} pendingLabel="Redirecting…">
                {creating ? "Authorise with OAuth" : "Authorise as another account"}
              </SubmitButton>
            </form>
          ) : (
            <form action={tokenAction} className="stack">
              <input type="hidden" name="productId" value={productId} />
              {creating && <label>Name<input name="provider" defaultValue={provider} placeholder="teamgrid" required /></label>}
              {serverField}
              <label>
                {creating ? "Account label" : "Connect as"}{" "}
                <span className="muted">(who this will be, for the connections list)</span>
                <input name="account" placeholder="user-y@company.com" />
              </label>
              <label>
                Access token
                <input
                  name="token"
                  type="password"
                  placeholder={creating ? "bearer token" : "the new account's bearer token"}
                  required
                />
              </label>
              <p className="sub">
                {creating
                  ? "For servers that do not implement OAuth. The token is sealed on arrival and no tool response can return it."
                  : "The token is sealed on arrival and never shown again. Whatever the previous account left behind — its refresh token, its expiry — is cleared with it."}
              </p>
              <SubmitButton icon={<Plug />} pendingLabel={creating ? "Connecting…" : "Reconnecting…"}>
                {creating ? "Connect with token" : "Reconnect with token"}
              </SubmitButton>
            </form>
          )}

          {!creating && (
            <p className="sub">
              The new account&apos;s tool list is checked against what is already bound. If it cannot see a bound
              tool, the connection is marked degraded and says which action is affected, rather than failing later
              on a send.
            </p>
          )}
        </div>
      </Drawer>
    </>
  );
}
