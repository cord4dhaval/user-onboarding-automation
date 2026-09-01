import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { routineCatalog, routineHealth } from "@/engine/routines.js";
import { describeCounters, latestRuns } from "@/engine/runlog.js";
import { requireSession, scope } from "../../../tenant";
import ClaudeBadge from "../../../ui/claude-badge";

export const dynamic = "force-dynamic";

function stamp(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export default async function Routines({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);
  const base = `/products/${id}`;

  const [connections, channels, goals, withChecks, people, health, latest] = await Promise.all([
    db.collection(C.connections).countDocuments({ ...s, status: "healthy" }),
    db.collection(C.channels).countDocuments({ ...s, enabled: true }),
    db.collection(C.goals).countDocuments(s),
    db.collection(C.goals).countDocuments({ ...s, "checks.0": { $exists: true } }),
    db.collection(C.people).countDocuments(s),
    routineHealth(orgId, id),
    latestRuns(orgId, id),
  ]);

  const byKey = new Map(health.map((h) => [h.key, h]));

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
  const routines = routineCatalog(id);

  return (
    <>
      <div className="head">
        <div>
          <h1>Routines</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            The engine sends on its own clock and needs no AI to do it. These three scheduled Claude sessions do
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
        <li>
          Go to <a href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">claude.ai/code/routines</a>{" "}
          and click <strong>New routine</strong>. Not a chat — scheduled chat tasks cannot take a cron.
        </li>
        <li>Name it, paste one prompt below, and pick any repository. The prompt touches no code; a routine just wants one to clone.</li>
        <li>Under <strong>Select a trigger</strong>, choose <strong>Schedule</strong> and enter the cron shown on the card.</li>
        <li>
          Under <strong>Connectors</strong>, keep this engine and remove every other one. A routine uses every tool
          of every connector left attached, writes included, without asking during a run.
        </li>
        <li>Create it, then <strong>Run now</strong>. Repeat for each routine, starting with Monitor and Plan.</li>
      </ol>
      <p className="sub">
        One hour is the floor Claude Code allows, and all three sit on it — a lead who arrives at 09:05
        should not wait two hours for a pipeline. The start minutes are staggered so the three never fire
        together over the same people. Each prompt opens by calling <code>register_routine</code>, which is how this app
        learns the schedule you set — it cannot read your Claude schedule any other way. Once a routine has
        registered, <a href={`${base}/logs`}>Logs</a> shows every run and the bell rings when one stops firing.
      </p>
      <p className="sub">
        A green run status in Claude only means the session started and exited. It does not mean the work
        happened — <a href={`${base}/logs`}>Logs</a> is the honest answer, because it records what the run
        actually changed here.
      </p>

      <h2>The three</h2>
      {routines.map((r) => {
        const h = byKey.get(r.key);
        const last = latest[r.key];

        return (
          <div className="card" key={r.key} style={{ marginBottom: 18 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>{r.name}</h3>
              <span className="pill accent">{r.human}</span>
              <code>{h?.cron ?? r.cron}</code>
              {r.essential ? (
                <span className="pill ok">start here</span>
              ) : (
                <span className="pill">add when needed</span>
              )}
              <span className="spacer" />
              <ClaudeBadge />
            </div>

            <div className="row" style={{ marginBottom: 10 }}>
              {h?.registered ? (
                <>
                  <span className="status">
                    <span className={h.state === "late" || h.state === "never" ? "dot bad" : "dot ok"} />
                    <span style={{ fontSize: 13.5 }}>
                      {last
                        ? <>Last ran {stamp(new Date(last.startedAt))} — {describeCounters(last.counters) || "nothing to do"}</>
                        : "Registered, but has not run yet"}
                    </span>
                  </span>
                  {h.nextRunAt ? (
                    <span className="muted" style={{ fontSize: 13 }}>· next {stamp(h.nextRunAt)}</span>
                  ) : null}
                  <a href={`${base}/logs?routine=${r.key}`} style={{ fontSize: 13 }}>Runs</a>
                </>
              ) : (
                <span className="status">
                  <span className="dot" />
                  <span className="muted" style={{ fontSize: 13.5 }}>
                    Not scheduled yet — paste the prompt below into <code>/schedule</code>.
                  </span>
                </span>
              )}
            </div>

            <p style={{ marginBottom: 8 }}>{r.job}</p>
            <p className="sub" style={{ marginBottom: 12 }}><strong>For example.</strong> {r.example}</p>

            <details>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Prompt to paste</summary>
              <pre style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>{r.prompt}</pre>
            </details>
          </div>
        );
      })}

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
          nothing done twice, nothing dropped. <a href={`${base}/logs`}>Logs</a> shows what each run actually did.
        </p>
      </div>
    </>
  );
}
