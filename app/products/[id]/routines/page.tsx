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
      name: "Monitor",
      cron: "5 * * * *",
      human: "every hour, at :05",
      essential: true,
      job: "Every person in an active campaign: where are they, are they done, and what happens next. Verification and monitoring are the same question about the same person, so they are answered in one pass.",
      example:
        "Priya's probes show an account and two sessions — marked succeeded, her two queued messages cancelled, the next campaign opened. Rahul has not moved in nine days and the profitability angle failed twice, so his remaining steps are replaced with the surveillance objection. Deepa replied \"ask in Q3\" — campaign closed, cooling until July, her reason recorded for whoever picks her up then.",
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "monitor".
2. If total_work_items is 0, stop and say "nothing to monitor".
3. For each person under in_flight, read last_probes — what the tools actually
   returned — alongside check_results and their last message. Decide:
     succeeded  the evidence plainly shows it. Not "probably".
     failed     a real ending: they said no, or the budget and deadline are
                spent. Never because a check has simply not passed yet.
     continue   still running. Say in one line where they are.
   Submit them together with mark_state.
4. Where someone is off-plan — stalled, or a signal the plan did not expect —
   call plan_goal with a new version and say why the old one is being replaced.
5. For each reply: read it, then record_reply with a grounded answer. Never
   invent a capability to close someone.
6. For each undetermined check: verify_person, read the raw response, and
   resolve_check only if it plainly supports the verdict.
7. On your first run of the day, also look at verification_looks_wrong. Those
   campaigns have run two weeks with nothing passing, which usually means a
   check is bound to the wrong tool. Use verifiers and set_checks to fix it.`,
    },
    {
      name: "Plan",
      cron: "20 */2 * * *",
      human: "every 2 hours, at :20",
      essential: true,
      job: "New people get understood and given a pipeline. New campaigns get a verification plan — which can only happen here, because the browser that created them cannot call Claude.",
      example:
        "Twelve leads arrive overnight. Priya reads as an engineering leader whose problem is no honest view of where the team's time goes, so her pipeline opens by showing the product. Deepa in HR gets a different one entirely, opening on audit-ready attendance.",
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "plan".
2. If total_work_items is 0, stop.
3. For anything under need_verification_plan: call verifiers to see what could
   answer that campaign's success sentence, then set_checks. Until this exists
   the campaign cannot mark anyone as succeeded.
4. Classify unclassified people in batches — lead_card for context, then submit
   them all in one classify call.
5. For each campaign under need_plan: lead_card, then plan_goal with 3-5 steps.
   Use only channels the campaign allows; lead_card lists what is connected and
   what each can carry. Stay inside the budget and the cadence for that
   temperature.
6. Stop after 40 people and leave the rest for the next run.`,
    },
    {
      name: "Compose",
      cron: "35 */2 * * *",
      human: "every 2 hours, at :35",
      essential: false,
      job: "Write the messages about to go out — in the shape of the channel each one is going on. Only the next two days' worth.",
      example:
        "Rahul's replanned step is due Thursday on email: subject line, around 140 words, a link, an opt-out. His step after that is WhatsApp: about 45 words, no link, and outside the 24-hour window it has to use an approved template. Same angle, two different pieces of writing.",
      prompt: `${preamble}

Every run:
1. sweep with product_id "${id}" and scope "compose".
2. If total_work_items is 0, stop.
3. For each low buffer: compose_batch for steps due in the next 48 hours only.
   Not further ahead — a message written now for day 9 is usually wasted,
   because the person signs up or unsubscribes first.
4. Write to the channel's shape. lead_card lists each channel's real limits:
   an email carries a subject, a body of a few hundred words, a link and an
   opt-out; a WhatsApp message is a couple of sentences with no link, and
   outside its reply window it must use an approved template. The same angle
   becomes two different pieces of writing.
5. Read their prior touches. Never repeat a claim already made to them, never
   contradict one, and let the register escalate naturally across a sequence.
6. Stop after 30 touches.`,
    },
  ];

  return (
    <>
      <div className="head">
        <div>
          <h1>Routines</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            The engine sends on its own clock and needs no AI to do it. These four scheduled Claude sessions do
            the part that needs judgment. Nothing they do is urgent, which is what makes running three of them
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

      <h2>The three</h2>
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
            <tr><td><strong>Monitor</strong></td><td>Everything sends; the engine still gathers evidence</td><td>Nobody is marked as finished, and replies go unanswered</td></tr>
            <tr><td><strong>Plan</strong></td><td>Welcomes go out, existing sequences continue</td><td>New people stay unclassified; new campaigns cannot verify</td></tr>
            <tr><td><strong>Compose</strong></td><td>Anything already written still sends</td><td>Sequences run dry after about two days</td></tr>
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
