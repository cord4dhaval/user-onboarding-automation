import { requireSession } from "../../../tenant";
import { runCalls, toggleRoutine } from "../../../actions";
import { routineHealth, type RoutineHealth } from "@/engine/routines.js";
import { describeCounters, latestRuns, listRuns, sumCounters, type RunKind, type RunRow } from "@/engine/runlog.js";
import RunDrawer from "./run-drawer";

export const dynamic = "force-dynamic";

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "Everything" },
  { key: "monitor", label: "Monitor" },
  { key: "plan", label: "Plan" },
  { key: "compose", label: "Compose" },
  { key: "engine", label: "Engine" },
  { key: "ad-hoc", label: "By hand" },
];

const KIND_LABELS: Record<RunKind, string> = {
  monitor: "Monitor",
  plan: "Plan",
  compose: "Compose",
  engine: "Engine",
  "ad-hoc": "By hand",
};

/** Absolute times are unreadable in a list; "14 minutes ago" is what you actually want. */
function ago(from: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function until(to: Date, now: Date): string {
  const minutes = Math.round((to.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

function stamp(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function took(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function statusPill(run: RunRow) {
  if (run.status === "running") return <span className="pill accent">running</span>;
  if (run.status === "error") return <span className="pill bad">{run.errors} error{run.errors === 1 ? "" : "s"}</span>;
  if (run.status === "stalled") return <span className="pill bad">stalled</span>;
  return <span className="pill ok">ok</span>;
}

function healthDot(health: RoutineHealth) {
  if (health.state === "late" || health.state === "never") return <span className="dot bad" />;
  if (health.state === "unregistered" || health.state === "paused") return <span className="dot" />;
  return <span className="dot ok" />;
}

function healthWord(health: RoutineHealth): string {
  switch (health.state) {
    case "unregistered":
      return "never set up";
    case "paused":
      return "alerts paused";
    case "never":
      return "registered, never ran";
    case "late":
      return `${health.lateByMinutes} min late`;
    default:
      return "on schedule";
  }
}

export default async function Logs({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ routine?: string }>;
}) {
  const { id } = await params;
  const { routine = "all" } = await searchParams;
  const { orgId } = await requireSession();
  const now = new Date();
  const base = `/products/${id}`;

  const [health, latest, runs] = await Promise.all([
    routineHealth(orgId, id),
    latestRuns(orgId, id),
    listRuns(orgId, id, { routine, limit: 80 }),
  ]);

  const today = runs.filter((r) => now.getTime() - new Date(r.startedAt).getTime() < 86_400_000);
  const todayTotals = describeCounters(sumCounters(today));
  const engine = latest.engine;

  return (
    <>
      <div className="head">
        <div>
          <h1>Logs</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Every routine run and what it did. A routine runs inside Claude, not here, so what you see below is
            reconstructed from the calls it made: a run opens when a routine sweeps and closes when it goes
            quiet. Counters are kept for 30 days, the raw calls behind them for 14.
          </p>
        </div>
      </div>

      <h2>The three routines</h2>
      <div className="grid">
        {health.map((h) => {
          const last = latest[h.key];
          return (
            <div className="card" key={h.key}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="status">{healthDot(h)}<strong>{h.name}</strong></span>
                <span className="spacer" />
                <code>{h.cron}</code>
              </div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>{healthWord(h)}</div>

              {last ? (
                <>
                  <div style={{ fontSize: 13.5 }}>
                    Last ran {ago(new Date(last.startedAt), now)} · {took(last.ms)}
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                    {describeCounters(last.counters) || "nothing to do"}
                  </div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 13.5 }}>No run recorded yet.</div>
              )}

              <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                {h.registered ? (
                  h.nextRunAt ? <>Next {until(h.nextRunAt, now)} · {stamp(h.nextRunAt)}</> : "Schedule unreadable"
                ) : (
                  <>Not registered — <a href={`${base}/routines`}>schedule it</a></>
                )}
              </div>

              {h.registered && (h.state === "late" || h.state === "never" || h.state === "paused") ? (
                <form action={toggleRoutine.bind(null, id, h.key, h.state === "paused")} style={{ marginTop: 10 }}>
                  <button type="submit" className="quiet sm">
                    {h.state === "paused" ? "Resume alerts" : "Pause alerts"}
                  </button>
                </form>
              ) : null}
            </div>
          );
        })}

        <div className="card">
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="status">
              <span className={engine && now.getTime() - new Date(engine.startedAt).getTime() < 3_600_000 ? "dot ok" : "dot"} />
              <strong>Engine</strong>
            </span>
            <span className="spacer" />
            <code>every minute</code>
          </div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            The clock. Needs no AI, and only the ticks that did something are logged.
          </div>
          {engine ? (
            <>
              <div style={{ fontSize: 13.5 }}>Last did work {ago(new Date(engine.startedAt), now)}</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{describeCounters(engine.counters)}</div>
            </>
          ) : (
            <div className="muted" style={{ fontSize: 13.5 }}>
              No tick has had anything to do yet. That is normal on a quiet product, and a problem if messages
              are queued.
            </div>
          )}
        </div>
      </div>

      {todayTotals ? (
        <div className="note" style={{ marginTop: 18 }}>
          <p style={{ margin: 0 }}>
            <strong>Last 24 hours.</strong> {todayTotals}, across {today.length} run{today.length === 1 ? "" : "s"}.
          </p>
        </div>
      ) : null}

      <h2>Runs</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <a
            key={f.key}
            href={f.key === "all" ? `${base}/logs` : `${base}/logs?routine=${f.key}`}
            className={`pill ${routine === f.key ? "accent" : ""}`}
          >
            {f.label}
          </a>
        ))}
      </div>

      {runs.length === 0 ? (
        <div className="empty">
          <strong>Nothing logged yet</strong>
          A run appears here the first time a routine sweeps. If you have scheduled one and this stays empty,
          the connector is probably not attached to the schedule — see <a href={`${base}/routines`}>Routines</a>.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Routine</th>
                <th>What it did</th>
                <th className="num">Calls</th>
                <th className="num">Took</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const startedAt = new Date(run.startedAt);
                return (
                  <tr key={run.id}>
                    <td>
                      <strong>{ago(startedAt, now)}</strong>
                      <div className="muted num" style={{ fontSize: 12.5 }}>{stamp(startedAt)}</div>
                    </td>
                    <td><span className="pill">{KIND_LABELS[run.routine] ?? run.routine}</span></td>
                    <td className="muted">
                      {describeCounters(run.counters) || "nothing to do"}
                      {run.firstError ? (
                        <div style={{ fontSize: 12.5, marginTop: 3 }}>{run.firstError}</div>
                      ) : null}
                    </td>
                    <td className="num">{run.calls}</td>
                    <td className="num">{took(run.ms)}</td>
                    <td>{statusPill(run)}</td>
                    <td>
                      <RunDrawer
                        runId={run.id}
                        label="Detail"
                        title={`${KIND_LABELS[run.routine] ?? run.routine} · ${stamp(startedAt)}`}
                        subtitle={`${run.calls} call${run.calls === 1 ? "" : "s"} · ${took(run.ms)} · ${
                          describeCounters(run.counters) || "nothing to do"
                        }`}
                        fetchCalls={runCalls}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
