import { headers } from "next/headers";
import { CircleCheck, ExternalLink, ShieldCheck, TriangleAlert } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { TOOLS } from "@/mcp/server/tools.js";
import { scope } from "../../../tenant";

/**
 * Everything needed to point a Claude session at this engine, in the order it is done:
 * a URL, a token, a connector. The tool list sits underneath because it is read once.
 */
export default async function SetupPanel({ productId, orgId }: { productId: string; orgId: string }) {
  const db = await getDb();
  const s = scope(orgId, productId);

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
    <>
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

      {isLocal && (
        <div className="note bad">
          <p className="row" style={{ margin: 0, gap: 8 }}>
            <TriangleAlert size={16} />
            <span>
              <strong>This app is on localhost.</strong> A cloud routine runs in Anthropic&apos;s cloud and
              cannot reach your machine. Deploy to a public URL first — Mongo already points at Atlas, so only
              the app has to move.
            </span>
          </p>
        </div>
      )}

      <h2>Your MCP endpoint</h2>
      <pre>{origin}/api/mcp</pre>
      <p className="sub row" style={{ gap: 8 }}>
        {tokenSet ? (
          <>
            <CircleCheck size={15} />
            <span>Protected by <code>MCP_TOKEN</code>. Use that value as the bearer token on the connector.</span>
          </>
        ) : (
          <>
            <TriangleAlert size={15} />
            <span>
              <strong>No <code>MCP_TOKEN</code> set.</strong> Anyone who finds this URL can drive your engine.
              Set one before deploying.
            </span>
          </>
        )}
      </p>

      <h2>Register it as a connector</h2>
      <p className="sub">
        Add it as a custom connector with the URL above and your token as the bearer credential, then schedule
        the five routines on the next tab.
      </p>
      <a className="btn ghost" href="https://claude.ai/customize/connectors" target="_blank" rel="noreferrer">
        <ExternalLink size={14} /> Open Claude connectors
      </a>

      <h2>What runs where</h2>
      <div className="tw">
        <table>
          <tbody>
            <tr>
              <th style={{ width: 170 }}>Engine, every minute</th>
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
      <div className="tw scroll">
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
        <p className="row" style={{ margin: 0, gap: 8 }}>
          <ShieldCheck size={16} />
          <span>
            <strong>Claude never sees a credential.</strong> These tools return connection ids, provider names
            and status. Every secret is resolved inside the engine at send time.
          </span>
        </p>
      </div>
    </>
  );
}
