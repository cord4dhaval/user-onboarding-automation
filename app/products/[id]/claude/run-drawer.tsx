"use client";

import { useState, useTransition } from "react";
import { Eye } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, Spinner } from "../../../ui/kit";
import type { CallRow } from "@/engine/runlog.js";

/**
 * A run's summary is what you read; its raw calls are what you read when the summary looks
 * wrong. They are fetched on open rather than with the page, because sixty runs of raw
 * arguments and results is a few megabytes to render four lines of counters.
 */
export default function RunDrawer({
  runId,
  title,
  subtitle,
  label,
  fetchCalls,
}: {
  runId: string;
  title: string;
  subtitle: string;
  label: string;
  fetchCalls: (runId: string) => Promise<CallRow[]>;
}) {
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [pending, start] = useTransition();

  function show() {
    setOpen(true);
    if (calls) return;
    start(async () => setCalls(await fetchCalls(runId)));
  }

  return (
    <>
      <Button variant="quiet" size="sm" icon={<Eye />} loading={pending && !calls} onClick={show}>
        {label}
      </Button>
      <Drawer open={open} title={title} description={subtitle} onClose={() => setOpen(false)} width={720}>
        {pending && !calls ? (
          <p className="muted row"><Spinner /> Loading the calls…</p>
        ) : !calls?.length ? (
          <div className="empty">
            <strong>No calls kept</strong>
            Raw calls are held for 14 days; the counters for this run are held for 30.
          </div>
        ) : (
          <ol className="calls">
            {calls.map((call, index) => (
              <li key={call.id}>
                <div className="row">
                  <span className="muted num">{index + 1}</span>
                  <code>{call.tool}</code>
                  {call.error ? <span className="pill bad">error</span> : null}
                  <span className="spacer" />
                  <span className="muted num" style={{ fontSize: 12.5 }}>{call.ms} ms</span>
                  <span className="muted num" style={{ fontSize: 12.5 }}>
                    {new Date(call.ts).toISOString().slice(11, 19)}
                  </span>
                </div>
                {call.error ? <pre className="bad-pre">{call.error}</pre> : null}
                <details>
                  <summary className="muted">Arguments</summary>
                  <pre>{call.args ?? "none"}</pre>
                </details>
                {call.result ? (
                  <details>
                    <summary className="muted">Result</summary>
                    <pre>{call.result}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Drawer>
    </>
  );
}
