import { headers } from "next/headers";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { TOOLS } from "@/mcp/server/tools.js";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function ClaudeSetup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = process.env.APP_URL?.replace(/\/$/, "") ?? `${proto}://${host}`;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  const tokenSet = Boolean(process.env.MCP_TOKEN);

  const [unclassified, needPlan] = await Promise.all([
    db.collection(C.people).countDocuments({ ...s, needsClassification: true }),
    db.collection(C.goalInstances).countDocuments({ ...s, status: "active", currentPlanId: { $exists: false } }),
  ]);

  return (
    <main>
      <h1>Connect Claude</h1>
      <p className="sub">
        The engine sends on its own clock. Claude does the thinking — who this person is, what pipeline they
        should get, and what each message actually says.
      </p>

      <div className="grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="label">Waiting to be classified</div>
          <div className="value">{unclassified}</div>
        </div>
        <div className="card">
          <div className="label">Waiting for a plan</div>
          <div className="value">{needPlan}</div>
        </div>
        <div className="card">
          <div className="label">Tools exposed</div>
          <div className="value">{TOOLS.length}</div>
        </div>
      </div>

      <h2>1. Deploy</h2>
      {isLocal ? (
        <div className="note warn-note">
          <strong>This app is on localhost.</strong>
          <p style={{ margin: "6px 0 0" }}>
            A cloud routine runs in Anthropic&apos;s cloud and cannot reach your machine. Deploy to a public URL
            first — the Mongo connection already points at Atlas, so only the app has to move.
          </p>
        </div>
      ) : (
        <p>
          Deployed at <code>{origin}</code>.
        </p>
      )}

      <h2>2. Your MCP endpoint</h2>
      <pre>{origin}/api/mcp</pre>
      <p className="sub">
        {tokenSet ? (
          <>
            Protected by <code>MCP_TOKEN</code>. Use that value as the bearer token on the connector.
          </>
        ) : (
          <>
            <strong>No <code>MCP_TOKEN</code> set.</strong> Anyone who finds this URL can drive your engine. Set
            one before deploying.
          </>
        )}
      </p>

      <h2>3. Register it as a connector</h2>
      <p>
        Go to <a href="https://claude.ai/customize/connectors">claude.ai/customize/connectors</a>, add a custom
        connector, and paste the URL above with your token as the bearer credential.
      </p>

      <h2>4. Schedule the routines</h2>
      <p className="sub">
        Three scheduled Claude sessions do the work that needs judgment: Monitor decides where each person is
        and whether they are finished, Plan understands new people and writes verification plans, and Compose
        writes the messages about to go out. Their prompts, what each handles, and what happens when one stops
        are on the <a href={`/products/${id}/routines`}>Routines page</a>.
      </p>

      <div className="note">
        <strong>What runs where</strong>
        <table style={{ marginTop: 8 }}>
          <tbody>
            <tr>
              <th style={{ width: 150 }}>Engine, every minute</th>
              <td>
                Fetch due sources · send what is due · reconcile delivery · run each campaign&apos;s checks and
                settle the clear ones. No model.
              </td>
            </tr>
            <tr>
              <th>Claude, hourly</th>
              <td>
                Replies · checks the engine could not settle · classification · plans · copy for what is about
                to send.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Tools Claude can call</h2>
      <div className="tw">
        <table>
          <thead><tr><th>Tool</th><th>Does</th></tr></thead>
          <tbody>
            {TOOLS.map((t) => (
              <tr key={t.name}>
                <td><code>{t.name}</code></td>
                <td className="muted">{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="note">
        <strong>Claude never sees a credential.</strong>
        <p style={{ margin: "6px 0 0" }}>
          These tools return connection ids, provider names and status. Every secret is resolved inside the
          engine at send time and never appears in a tool response.
        </p>
      </div>
    </main>
  );
}
