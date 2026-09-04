import { CircleCheck, CircleDashed, ExternalLink } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { routineCatalog, routineHealth } from "@/engine/routines.js";
import { describeCounters, latestRuns } from "@/engine/runlog.js";
import { scope } from "../../../tenant";
import ClaudeBadge from "../../../ui/claude-badge";
import CopyButton from "./copy-button";
import { ist } from "../../../ui/time";

function stamp(at: Date): string {
  return ist(at);
}

/**
 * The scheduled sessions, what each is waiting on, and the prompt that creates it.
 * Prerequisites come first: a routine scheduled before there is anything to think about
 * runs cleanly and does nothing, which reads exactly like a broken one.
 */
export default async function RoutinesPanel({ productId, orgId }: { productId: string; orgId: string }) {
  const db = await getDb();
  const s = scope(orgId, productId);
  const base = `/products/${productId}`;

  const [connections, channels, goals, withChecks, health, latest] = await Promise.all([
    db.collection(C.connections).countDocuments({ ...s, status: "healthy" }),
    db.collection(C.channels).countDocuments({ ...s, enabled: true }),
    db.collection(C.goals).countDocuments(s),
    db.collection(C.goals).countDocuments({ ...s, "checks.0": { $exists: true } }),
    routineHealth(orgId, productId),
    latestRuns(orgId, productId),
  ]);

  const byKey = new Map(health.map((h) => [h.key, h]));

  // Ordered as a chain: each step is pointless until the one above it is done.
  const prerequisites = [
    { label: "A connection is authorised", done: connections > 0, href: `${base}/connections` },
    { label: "A channel can send", done: channels > 0, href: `${base}/channels` },
    { label: "A campaign exists", done: goals > 0, href: `${base}/goals` },
    { label: "Campaigns know how to verify success", done: goals > 0 && withChecks === goals, href: `${base}/goals` },
  ];
  const ready = prerequisites.every((p) => p.done);

  return (
    <>
      <div className={`note ${ready ? "good" : "warn"}`}>
        <div className="checks">
          {prerequisites.map((p) => (
            <span className="status" key={p.label}>
              {p.done ? <CircleCheck size={15} color="var(--good)" /> : <CircleDashed size={15} color="var(--warm)" />}
              {p.done ? p.label : <a href={p.href}>{p.label}</a>}
            </span>
          ))}
        </div>
        <p className="sub tight">
          {ready
            ? "Everything a routine needs is in place. Schedule the ones below."
            : "Routines will run and find nothing to do until these are done — each is pointless until the one before it is."}
        </p>
      </div>

      <h2>How to schedule one</h2>
      <ol className="steps">
        <li>
          Open{" "}
          <a href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">
            claude.ai/code/routines <ExternalLink size={12} />
          </a>{" "}
          and click <strong>New routine</strong>.
          <span className="hint">A routine, not a chat — a scheduled chat cannot take a cron.</span>
        </li>
        <li>
          Paste one prompt from the cards below, and pick any repository.
          <span className="hint">The prompt touches no code; a routine just wants a repository to clone.</span>
        </li>
        <li>
          Under <strong>Schedule</strong>, enter the cron shown on that card.
        </li>
        <li>
          Under <strong>Connectors</strong>, keep this engine and remove every other one.
          <span className="hint">A routine calls every tool of every connector left attached, writes included.</span>
        </li>
        <li>
          Create it, then hit <strong>Run now</strong>.
          <span className="hint">Schedule Acquire and Advance first — they are what turns arrivals into mail. React and Close matter as soon as anyone starts clicking and replying, and Maintain is a once-a-day tidy you can add later.</span>
        </li>
      </ol>

      <div className="note">
        <p className="tight">
          A green run in Claude only means the session started. The <strong>Runs</strong> tab is the honest
          answer, because it records what a run actually changed here — each prompt opens by calling{" "}
          <code>register_routine</code>, which is how this app learns the schedule you set.
        </p>
      </div>

      {routineCatalog(productId).map((r) => {
        const h = byKey.get(r.key);
        const last = latest[r.key];

        return (
          <div className="card routine" key={r.key}>
            <div className="routine-head">
              <h3>{r.name}</h3>
              <span className="pill accent">{r.human}</span>
              <code>{h?.cron ?? r.cron}</code>
              {r.essential && <span className="pill ok">start here</span>}
              <span className="spacer" />
              <ClaudeBadge />
            </div>

            <div className="row routine-state">
              {h?.registered ? (
                <>
                  <span className="status">
                    <span className={h.state === "late" || h.state === "never" ? "dot bad" : "dot ok"} />
                    {last ? (
                      <>
                        Last ran {stamp(new Date(last.startedAt))} — {describeCounters(last.counters) || "nothing to do"}
                      </>
                    ) : (
                      "Registered, but has not run yet"
                    )}
                  </span>
                  {h.nextRunAt && <span className="muted">· next {stamp(h.nextRunAt)}</span>}
                  <a href={`${base}/claude?tab=logs&routine=${r.key}`}>Runs</a>
                </>
              ) : (
                <span className="status">
                  <span className="dot" />
                  <span className="muted">Not scheduled yet</span>
                </span>
              )}
            </div>

            <p className="routine-job">{r.job}</p>

            <div className="routine-example">
              <span className="label">What that looks like</span>
              <ul>
                {r.example.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            <details>
              <summary>Prompt to paste</summary>
              <div className="prompt-box">
                <CopyButton text={r.prompt} />
                <pre>{r.prompt}</pre>
              </div>
            </details>
          </div>
        );
      })}

      <h2>If one stops</h2>
      <div className="tw scroll">
        <table>
          <thead><tr><th>Stops</th><th>Still works</th><th>Waits</th></tr></thead>
          <tbody>
            <tr><td><strong>Monitor</strong></td><td>Everything sends; the engine still gathers evidence</td><td>Nobody is marked finished, replies go unanswered</td></tr>
            <tr><td><strong>Plan</strong></td><td>Welcomes go out, existing sequences continue</td><td>New people stay unclassified; new campaigns cannot verify</td></tr>
            <tr><td><strong>Compose</strong></td><td>Anything already written still sends</td><td>Sequences run dry after about two days</td></tr>
            <tr><td><strong>Groom</strong></td><td>Everything running keeps running</td><td>Half-finished setup stays half-finished and nobody is told</td></tr>
            <tr><td><strong>The engine</strong></td><td>Nothing sends</td><td>This is the one that matters</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
