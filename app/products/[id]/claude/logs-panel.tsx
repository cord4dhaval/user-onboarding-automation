import { runCalls, toggleRoutine } from "../../../actions";
import { routineHealth, type RoutineHealth } from "@/engine/routines.js";
import {
  closeIdleRuns,
  describeCounters,
  latestRuns,
  listRuns,
  sumCounters,
  type RunKind,
  type RunRow,
} from "@/engine/runlog.js";
import { ActionButton } from "../../../ui/kit";
import { ist } from "../../../ui/time";
import RunDrawer from "./run-drawer";

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "Everything" },
  { key: "monitor", label: "Monitor" },
  { key: "plan", label: "Plan" },
  { key: "compose", label: "Compose" },
  { key: "groom", label: "Groom" },
  { key: "engine", label: "Engine" },
  { key: "ad-hoc", label: "By hand" },
];

const KIND_LABELS: Record<RunKind, string> = {
  monitor: "Monitor",
  plan: "Plan",
  compose: "Compose",
  groom: "Groom",
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
  return ist(at);
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

/**
 * Every routine run and what it did. A routine runs inside Claude, not here, so this is
 * reconstructed from the calls it made: a run opens when a routine sweeps and closes when
 * it goes quiet.
 */
export default async function LogsPanel({
  productId,
  orgId,
  routine = "all",
}: {
  productId: string;
  orgId: string;
  routine?: string;
}) {
  const now = new Date();
  const base = `/products/${productId}/claude`;

  // The tick normally does this once a minute. Doing it here too means the page is right
  // even on a product whose clock is not wired up yet.
  await closeIdleRuns(now);

  const [health, latest, runs] = await Promise.all([
    routineHealth(orgId, productId),
    latestRuns(orgId, productId),
    listRuns(orgId, productId, { routine, limit: 80 }),
  ]);

  const today = runs.filter((r) => now.getTime() - new Date(r.startedAt).getTime() < 86_400_000);
  const todayTotals = describeCounters(sumCounters(today));
  const engine = latest.engine;

  return (
    <>
      <div className="grid routine-grid">
        {health.map((h) => {
          const last = latest[h.key];
          return (
            <div className="card" key={h.key}>
              <div className="row routine-head">
                <span className="status">{healthDot(h)}<strong>{h.name}</strong></span>
              </div>
              <div className="routine-state"><code>{h.cron}</code> · {healthWord(h)}</div>

              {last ? (
                <>
                  <div className="routine-last">Last ran {ago(new Date(last.startedAt), now)} · {took(last.ms)}</div>
                  <div className="routine-detail">
                    {describeCounters(last.counters) || "nothing to do"}
                  </div>
                </>
              ) : (
                <div className="routine-last muted">No run recorded yet.</div>
              )}

              <div className="routine-next">
                {h.registered ? (
                  h.nextRunAt ? <>Next {until(h.nextRunAt, now)} · {stamp(h.nextRunAt)}</> : "Schedule unreadable"
                ) : (
                  <>Not registered — <a href={`${base}?tab=routines`}>schedule it</a></>
                )}
              </div>

              {h.registered && (h.state === "late" || h.state === "never" || h.state === "paused") ? (
                <div className="routine-act">
                  <ActionButton
                    variant="quiet"
                    size="sm"
                    action={toggleRoutine.bind(null, productId, h.key, h.state === "paused")}
                  >
                    {h.state === "paused" ? "Resume alerts" : "Pause alerts"}
                  </ActionButton>
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="card">
          <div className="row routine-head">
            <span className="status">
              <span className={engine && now.getTime() - new Date(engine.startedAt).getTime() < 3_600_000 ? "dot ok" : "dot"} />
              <strong>Engine</strong>
            </span>
          </div>
          <div className="routine-state">
            <code>every minute</code> · the clock. No AI, and only ticks that did something are logged.
          </div>
          {engine ? (
            <>
              <div className="routine-last">Last did work {ago(new Date(engine.startedAt), now)}</div>
              <div className="routine-detail">{describeCounters(engine.counters)}</div>
            </>
          ) : (
            <div className="routine-last muted">
              No tick has had anything to do yet. Normal on a quiet product, a problem if messages are queued.
            </div>
          )}
        </div>
      </div>

      {todayTotals ? (
        <div className="note runs-note">
          <p className="tight">
            <strong>Last 24 hours.</strong> {todayTotals}, across {today.length} run{today.length === 1 ? "" : "s"}.
          </p>
        </div>
      ) : null}

      <h2>Runs</h2>
      <div className="row runs-filters">
        {FILTERS.map((f) => (
          <a
            key={f.key}
            href={f.key === "all" ? `${base}?tab=logs` : `${base}?tab=logs&routine=${f.key}`}
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
          the connector is probably not attached to the schedule.
        </div>
      ) : (
        <div className="tw scroll">
          <table className="runs-table">
            <colgroup>
              <col className="c-when" />
              <col className="c-routine" />
              <col />
              <col className="c-calls" />
              <col className="c-took" />
              <col className="c-result" />
              <col className="c-open" />
            </colgroup>
            <thead>
              <tr>
                <th>When</th><th>Routine</th><th>What it did</th>
                <th className="num">Calls</th><th className="num">Took</th><th>Result</th><th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const startedAt = new Date(run.startedAt);
                return (
                  <tr key={run.id}>
                    <td className="run-when">
                      <strong>{ago(startedAt, now)}</strong>
                      <div className="run-stamp num">{stamp(startedAt)}</div>
                    </td>
                    <td><span className="pill">{KIND_LABELS[run.routine] ?? run.routine}</span></td>
                    <td className="run-did">
                      {describeCounters(run.counters) || "nothing to do"}
                      {run.firstError ? <div className="run-error">{run.firstError}</div> : null}
                    </td>
                    <td className="num">{run.calls}</td>
                    <td className="num">{took(run.ms)}</td>
                    <td>{statusPill(run)}</td>
                    <td className="run-open">
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
