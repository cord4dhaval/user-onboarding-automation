import { headers } from "next/headers";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { TOOLS } from "@/mcp/server/tools.js";
import { scope } from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function ClaudeSetup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const s = scope(id);

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

  const routinePrompt = `Run the conversion-engine sweep for product ${id}.

1. Call sweep with product_id "${id}".
2. If total_work_items is 0, stop and report "nothing to do".
3. For each unclassified person: call lead_card, work out their segment,
   pain, likely objections and ICP fit from the product config and their
   company, then submit them all in one classify call.
4. For each goal instance in need_plan: call lead_card, then plan_goal with
   3-5 steps. Each step needs a channel, an angle, days from now, and a
   one-line why. Respect the goal's budget and cadence_by_temp.
5. For each low buffer: call compose_batch for the next 2 touches on that
   plan. Write real copy in the product's voice. Never repeat a claim that
   already appears in the person's touch history.
6. Report what you classified, planned and composed.

Do not call fire_due — the engine sends on its own schedule.`;

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

      <h2>4. Create the routine</h2>
      <p className="sub">
        In a Claude session, run <code>/schedule</code>, attach the connector, and paste this prompt. Hourly is
        right — the fast path is the engine, which needs no model. Minimum interval is one hour.
      </p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{routinePrompt}</pre>

      <div className="note">
        <strong>What runs where</strong>
        <table style={{ marginTop: 8 }}>
          <tbody>
            <tr>
              <th style={{ width: 150 }}>Engine, every minute</th>
              <td>Fetch due sources · send what is due · reconcile delivery. No model.</td>
            </tr>
            <tr>
              <th>Claude, hourly</th>
              <td>Classify · plan · compose the next touches · draft replies.</td>
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
