import { createConnection, probeAuth, startOAuth } from "../../../../actions";

export const dynamic = "force-dynamic";

export default async function NewConnection({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ probed?: string; oauth?: string; dcr?: string }>;
}) {
  const { id } = await params;
  const probe = await searchParams;
  const probed = probe.probed;
  const oauthSupported = probe.oauth === "true";
  const dcrSupported = probe.dcr === "true";

  return (
    <main>
      <h1>Connect an MCP server</h1>
      <p className="sub">
        One connection can both pull leads in and send messages out. Whichever way you authorise, the secret is
        encrypted on arrival and never leaves the server — it is not shown again, and no tool response can
        return it.
      </p>

      <h2>Step 1 — check what this server supports</h2>
      <form action={probeAuth} className="stack">
        <input type="hidden" name="productId" value={id} />
        <label>
          Server URL
          <input name="serverUrl" type="url" placeholder="https://mcp.teamgrid.ai/mcp" defaultValue={probed} required />
        </label>
        <button type="submit" className="ghost">Check</button>
      </form>

      {probed && (
        <div className="note">
          <code>{probed}</code>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            <li>
              OAuth:{" "}
              {oauthSupported ? (
                <span className="pill ok">supported</span>
              ) : (
                <span className="pill warn">not advertised — use an access token</span>
              )}
            </li>
            {oauthSupported && (
              <li>
                Automatic client registration:{" "}
                {dcrSupported ? (
                  <span className="pill ok">supported</span>
                ) : (
                  <span className="pill warn">not supported — you will need a client ID from the provider</span>
                )}
              </li>
            )}
          </ul>
        </div>
      )}

      <h2>Step 2 — authorise</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="label">Option A — OAuth (recommended)</div>
        <p className="sub" style={{ margin: "0 0 12px" }}>
          You approve on the provider&apos;s own consent screen. We never see a password, the token refreshes
          itself, and access can be revoked from their side at any time.
        </p>
        <form action={startOAuth} className="stack">
          <input type="hidden" name="productId" value={id} />
          <label>Name<input name="provider" placeholder="teamgrid" required /></label>
          <label>
            Server URL
            <input name="serverUrl" type="url" defaultValue={probed} placeholder="https://mcp.teamgrid.ai/mcp" required />
          </label>
          <label>
            Client ID <span className="muted">(only if the server has no automatic registration)</span>
            <input name="clientId" placeholder="leave blank to register automatically" />
          </label>
          <label>
            Client secret <span className="muted">(only if the provider issued one)</span>
            <input name="clientSecret" type="password" placeholder="usually not needed" />
          </label>
          <button type="submit">Authorise with OAuth</button>
        </form>
      </div>

      <div className="card">
        <div className="label">Option B — access token</div>
        <p className="sub" style={{ margin: "0 0 12px" }}>
          For servers that do not implement OAuth. Paste a bearer token the provider issued you.
        </p>
        <form action={createConnection} className="stack">
          <input type="hidden" name="productId" value={id} />
          <label>Name<input name="provider" placeholder="teamgrid" required /></label>
          <label>
            Server URL
            <input name="serverUrl" type="url" defaultValue={probed} placeholder="https://mcp.teamgrid.ai/mcp" required />
          </label>
          <label>Access token<input name="token" type="password" placeholder="bearer token" required /></label>
          <button type="submit">Connect with token</button>
        </form>
      </div>

      <div className="note">
        Either way, the next screen lists the server&apos;s tools and you choose which one sends messages and
        which one returns new leads. Nothing is bound automatically — a wrong guess about which tool sends mail
        is expensive.
      </div>
    </main>
  );
}
