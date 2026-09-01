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

  const base = `Product ${id} on the conversion engine.`;

  /**
   * Four routines rather than one. They split by job and cadence, and their start minutes
   * are offset so they do not all fire on the hour. Each takes a work limit and leaves the
   * rest for its next run — safe, because sweep reads current state rather than draining a
   * queue.
   */
  const routines = [
    {
      name: "Triage",
      cron: "5 * * * *",
      human: "every hour, at :05",
      why: "Someone is stuck and nothing happens until a decision is made.",
      prompt: `${base}

Every run:
1. sweep with product_id "${id}" and scope "triage".
2. If total_work_items is 0, stop and say "nothing to triage".
3. For each reply: read it with lead_card, work out the intent, then draft a
   grounded answer with record_reply. Never invent a product capability to
   close someone — say what is true or escalate.
4. For each undetermined check: call verify_person, read the raw response the
   tool actually returned, and only call resolve_check if it plainly supports
   the verdict. If it does not, leave it and say what is ambiguous.
5. Report what you settled and what you left.`,
    },
    {
      name: "Plan",
      cron: "20 */2 * * *",
      human: "every 2 hours, at :20",
      why: "New people need a segment and a pipeline before anything can be written.",
      prompt: `${base}

Every run:
1. sweep with product_id "${id}" and scope "plan".
2. If total_work_items is 0, stop.
3. Classify unclassified people in batches — call lead_card for context, then
   submit them all in one classify call.
4. For each campaign in need_plan: lead_card, then plan_goal with 3-5 steps.
   Each step needs a channel, an angle, days from now, and a one-line why.
   Stay inside the campaign's budget and its cadence for that temperature.
5. Stop after 40 people and leave the rest for the next run.`,
    },
    {
      name: "Compose",
      cron: "35 */2 * * *",
      human: "every 2 hours, at :35",
      why: "Copy for what is about to send. Nothing further ahead than that.",
      prompt: `${base}

Every run:
1. sweep with product_id "${id}" and scope "compose".
2. If total_work_items is 0, stop.
3. For each low buffer: compose_batch for steps due in the next 48 hours only.
   Not three ahead — a message written now for day 9 is usually wasted, because
   the person signs up or unsubscribes first.
4. Write in the product's voice. Read the person's prior touches and never
   repeat a claim already made to them, or contradict one.
5. Stop after 30 touches.`,
    },
    {
      name: "Review",
      cron: "50 7 * * *",
      human: "daily, 07:50",
      why: "Slow work: whether the reads were right, and whether verification still points at the right tools.",
      prompt: `${base}

Every run:
1. sweep with product_id "${id}" and scope "review".
2. For anything under verification_looks_wrong: these campaigns have run two
   weeks with no check ever passing. Call verify_person, look at what the tools
   return, and if the plan is bound to the wrong tool, propose a better one with
   verifiers and set_checks.
3. Call report to compare what was predicted against what happened. Where a
   segment is consistently misjudged, say so plainly — that usually means the
   segment needs splitting rather than the copy needs changing.
4. Report findings. Change nothing else.`,
    },
  ];

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

      <h2>4. Create the routines</h2>
      <p className="sub">
        Four rather than one: they split by job and by how often that job actually needs doing, and their start
        minutes are offset so they do not all fire at once. Each stops at a work limit and leaves the rest for
        its next run — safe, because a sweep reads current state rather than draining a queue, so nothing is
        lost and nothing is done twice. Start with Triage and Plan; add the others when the first two are
        keeping up.
      </p>
      <p className="sub">
        In a Claude session run <code>/schedule</code>, attach the connector, and paste one prompt per routine.
        The minimum interval is one hour.
      </p>

      {routines.map((r) => (
        <div className="card" key={r.name} style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <strong>{r.name}</strong>
            <span className="pill accent">{r.human}</span>
            <code>{r.cron}</code>
          </div>
          <p className="sub" style={{ margin: "0 0 10px" }}>{r.why}</p>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{r.prompt}</pre>
        </div>
      ))}

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
