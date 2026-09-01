import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { requireSession, scope } from "../../../tenant";
import ClaudeBadge from "../../../ui/claude-badge";

export const dynamic = "force-dynamic";

interface Routine {
  name: string;
  cron: string;
  human: string;
  job: string;
  example: string;
  prompt: string;
  essential: boolean;
}

export default async function Routines({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);
  const base = `/products/${id}`;

  const [connections, channels, goals, withChecks, people] = await Promise.all([
    db.collection(C.connections).countDocuments({ ...s, status: "healthy" }),
    db.collection(C.channels).countDocuments({ ...s, enabled: true }),
    db.collection(C.goals).countDocuments(s),
    db.collection(C.goals).countDocuments({ ...s, "checks.0": { $exists: true } }),
    db.collection(C.people).countDocuments(s),
  ]);

  // Ordered as a chain: each step is pointless until the one above it is done.
  const prerequisites = [
    {
      label: "A connection is authorised",
      done: connections > 0,
      why: "Where leads come from, where messages go, and what answers whether someone succeeded.",
      href: `${base}/connections`,
    },
    {
      label: "A channel can send",
      done: channels > 0,
      why: "Without one, campaigns queue messages that never leave.",
      href: `${base}/channels`,
    },
    {
      label: "A campaign exists",
      done: goals > 0,
      why: "Routines have nothing to think about until there is something running.",
      href: `${base}/goals`,
    },
    {
      label: "Campaigns know how to verify success",
      done: goals > 0 && withChecks === goals,
      why: "Without checks a campaign runs to its budget and closes as unverified, whatever really happened.",
      href: `${base}/goals`,
    },
    {
      label: "The engine has a clock",
      done: true,
      why: "Something must hit /api/cron/tick every minute — cron-job.org, or your own scheduler.",
      href: `${base}/claude`,
      manual: true,
    },
  ];

  const ready = prerequisites.every((p) => p.done);
  const preamble = `Product ${id} on the conversion engine.`;

  const routines: Routine[] = [
    {
      name: "Triage",
      cron: "5 * * * *",
      human: "every hour, at :05",
      essential: true,
      job: "Someone is stuck and nothing moves until a decision is made — replies that arrived, and checks the engine could not interpret.",
      example:
        'Rahul replies "mid-migration, ask me in Q3". Triage recognises a deferral rather than a refusal, pulls July out of it, stops the four remaining messages, and closes gracefully. In July a campaign picks him up and opens on exactly that.',
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "triage".
2. If total_work_items is 0, stop and say "nothing to triage".
3. For each reply: read it with lead_card, work out the intent, then draft a
   grounded answer with record_reply. Never invent a product capability to
   close someone — say what is true, or escalate it.
4. For each undetermined check: call verify_person, read what the tool actually
   returned, and call resolve_check only if that response plainly supports the
   verdict. If it does not, leave it and say what is ambiguous.
5. Report what you settled and what you left.`,
    },
    {
      name: "Plan",
      cron: "20 */2 * * *",
      human: "every 2 hours, at :20",
      essential: true,
      job: "New people have to be understood before anything can be written to them — who they are, what they are stuck on, and the sequence that fits.",
      example:
        "Twelve leads arrive overnight. Priya, VP Engineering, is read as an engineering leader with no honest view of where the team's time goes, so her sequence opens by showing the product. Deepa in HR gets a different sequence entirely, opening on audit-ready attendance.",
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "plan".
2. If total_work_items is 0, stop.
3. Classify unclassified people in batches — lead_card for context, then submit
   them all in one classify call.
4. For each campaign in need_plan: lead_card, then plan_goal with 3-5 steps.
   Each step needs a channel, an angle, days from now, and a one-line why.
   Stay inside the campaign's budget and its cadence for that temperature.
5. Stop after 40 people and leave the rest for the next run.`,
    },
    {
      name: "Compose",
      cron: "35 */2 * * *",
      human: "every 2 hours, at :35",
      essential: false,
      job: "Write the messages about to go out — only the next two days' worth.",
      example:
        "Rahul's third message is due Thursday, so it is written on Tuesday, knowing he already got the profitability angle and never clicked. It opens on the surveillance objection instead, and cannot reuse a claim already made to him.",
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "compose".
2. If total_work_items is 0, stop.
3. For each low buffer: compose_batch for steps due in the next 48 hours only.
   Not three ahead — a message written now for day 9 is usually wasted, because
   the person signs up or unsubscribes first.
4. Write in the product's voice. Read their prior touches and never repeat a
   claim already made to them, or contradict one.
5. Stop after 30 touches.`,
    },
    {
      name: "Review",
      cron: "50 7 * * *",
      human: "daily, 07:50",
      essential: false,
      job: "Is any of this working, and is the system measuring itself correctly? The slow question nothing else has time for.",
      example:
        'Eight campaigns have run three weeks with no success recorded while those people are visibly clicking. The "has signed up" check was pointed at a tool that only returns currently-active users. Review re-points it, and eight campaigns about to close as failures are recorded as the successes they were.',
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "review".
2. For anything under verification_looks_wrong: these campaigns have run two
   weeks with no check ever passing. Call verify_person, look at what the tools
   return, and if a check is bound to the wrong tool, propose a better one with
   verifiers and set_checks.
3. Call report to compare what was predicted against what happened. Where a
   segment is consistently misjudged, say so — that usually means the segment
   needs splitting rather than the copy needs changing.
4. Report findings. Change nothing else.`,
    },
  ];

  return (
    <>
      <div className="head">
        <div>
          <h1>Routines</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            The engine sends on its own clock and needs no AI to do it. These four scheduled Claude sessions do
            the part that needs judgment. Nothing they do is urgent, which is what makes running four of them
            cheap and makes it safe when one misses a turn.
          </p>
        </div>
      </div>

      <h2>Before they can run</h2>
      <div className="tw">
        <table>
          <thead><tr><th /><th>Prerequisite</th><th>Why</th></tr></thead>
          <tbody>
            {prerequisites.map((p) => (
              <tr key={p.label}>
                <td style={{ width: 34 }}>
                  {p.done ? <span className="dot ok" /> : <span className="dot bad" />}
                </td>
                <td>
                  <strong>{p.label}</strong>
                  {p.manual && <div className="muted" style={{ fontSize: 12.5 }}>Checked by hand — we cannot see your scheduler</div>}
                </td>
                <td className="muted">
                  {p.why}{" "}
                  {!p.done && <a href={p.href}>Fix</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ready ? (
        <div className="note">
          <p style={{ margin: 0 }}>
            <strong>Ready.</strong> {people} {people === 1 ? "person" : "people"} in the library, {goals}{" "}
            {goals === 1 ? "campaign" : "campaigns"} defined. Connect the server on the{" "}
            <a href={`${base}/claude`}>Claude page</a>, then schedule the routines below.
          </p>
        </div>
      ) : (
        <div className="note bad">
          <p style={{ margin: 0 }}>
            <strong>Not ready.</strong> Routines will run and find nothing to do. Finish the steps above first —
            each one is pointless until the one before it is done.
          </p>
        </div>
      )}

      <h2>How to schedule one</h2>
      <ol className="sub" style={{ paddingLeft: 20 }}>
        <li>Connect this engine as a custom connector — see <a href={`${base}/claude`}>Claude</a>.</li>
        <li>In a Claude session, run <code>/schedule</code>.</li>
        <li>Attach the connector, paste one prompt below, set its cron, and create it.</li>
        <li>Repeat for each routine. Start with Triage and Plan.</li>
      </ol>
      <p className="sub">
        The minimum interval is one hour, and the start minutes below are deliberately staggered so the four
        never fire together.
      </p>

      <h2>The four</h2>
      {routines.map((r) => (
        <div className="card" key={r.name} style={{ marginBottom: 18 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{r.name}</h3>
            <span className="pill accent">{r.human}</span>
            <code>{r.cron}</code>
            {r.essential ? (
              <span className="pill ok">start here</span>
            ) : (
              <span className="pill">add when needed</span>
            )}
            <span className="spacer" />
            <ClaudeBadge />
          </div>

          <p style={{ marginBottom: 8 }}>{r.job}</p>
          <p className="sub" style={{ marginBottom: 12 }}><strong>For example.</strong> {r.example}</p>

          <details>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Prompt to paste</summary>
            <pre style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>{r.prompt}</pre>
          </details>
        </div>
      ))}

      <h2>If one stops</h2>
      <div className="tw">
        <table>
          <thead><tr><th>Stops</th><th>Still works</th><th>Waits</th></tr></thead>
          <tbody>
            <tr><td><strong>Triage</strong></td><td>Everything sends and verifies</td><td>Replies go unanswered — the most visible gap</td></tr>
            <tr><td><strong>Plan</strong></td><td>Welcomes go out, existing sequences continue</td><td>New people stay unclassified</td></tr>
            <tr><td><strong>Compose</strong></td><td>Anything already written still sends</td><td>Sequences run dry after about two days</td></tr>
            <tr><td><strong>Review</strong></td><td>Everything</td><td>Nothing, for a while. Least urgent by design.</td></tr>
            <tr><td><strong>The engine</strong></td><td>Nothing sends</td><td>This is the one that matters</td></tr>
          </tbody>
        </table>
      </div>

      <div className="note">
        <p style={{ margin: 0 }}>
          <strong>Nothing is ever lost.</strong> Each routine reads current state rather than draining a queue,
          so a run that fails halfway leaves the rest still marked. The next run picks up exactly what was left —
          nothing done twice, nothing dropped.
        </p>
      </div>
    </>
  );
}
