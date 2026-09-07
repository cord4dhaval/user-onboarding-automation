"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, SubmitButton } from "../../../ui/kit";

export interface SesRecord {
  kind: string;
  name: string;
  value: string;
  priority?: number;
  required: boolean;
}

/**
 * The DNS a customer has to publish, and where their domain has got to.
 *
 * Written to be read by somebody who is not the person who started this. The one with the
 * DNS password is usually a colleague or an agency, so every value copies in one press and
 * the whole block can be sent on — a table nobody can copy out of is a table that gets
 * retyped, and a retyped DKIM token is a domain that never verifies.
 *
 * Required and optional records are labelled rather than separated. The three CNAMEs decide
 * whether anything sends at all; the MAIL FROM pair only improves how the mail is judged,
 * and someone in a hurry should be able to see which is which without reading a paragraph.
 */
export default function SesRecords({
  domain,
  status,
  records,
  checksUntil,
  detail,
  recheckAction,
  restartAction,
}: {
  domain: string;
  status: "pending" | "verified" | "failed";
  records: SesRecord[];
  /** When AWS stops looking. Shown because a missed deadline is not recoverable by waiting. */
  checksUntil?: string;
  detail?: string;
  recheckAction: () => void | Promise<void>;
  restartAction: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState(status !== "verified");

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard is blocked in some browsers and every insecure origin. The values are on
      // screen and selectable, so this fails quietly rather than with an alert about a
      // permission nobody can grant from here.
    }
  };

  // The whole block as text, for forwarding to whoever runs the DNS.
  const asText = records
    .map((r) => `${r.kind}\t${r.name}\t${r.value}${r.priority ? `\tpriority ${r.priority}` : ""}`)
    .join("\n");

  if (status === "verified") {
    return (
      <p className="channel-meta">
        {domain} verified · DNS confirmed by Amazon
      </p>
    );
  }

  return (
    <div className="ses-records">
      <div className="channel-line">
        <span className={`pill ${status === "failed" ? "bad" : ""}`}>
          {status === "failed" ? "not verified" : "waiting on DNS"}
        </span>
        <strong>{domain}</strong>
      </div>

      {status === "failed" ? (
        <p className="channel-meta">
          {detail ?? "Amazon stopped checking for these records. Publishing them now will not help — the domain has to be added again, which issues new records."}
        </p>
      ) : (
        <p className="channel-meta">
          Nothing sends until these are live and Amazon confirms them. Usually minutes, sometimes hours.
          {checksUntil ? ` Amazon stops checking ${new Date(checksUntil).toLocaleString()}.` : ""}
        </p>
      )}

      {status !== "failed" && (
        <>
          <div className="row-actions">
            <Button variant="quiet" size="sm" onClick={() => setOpen(!open)}>
              {open ? "Hide records" : `Show ${records.length} records`}
            </Button>
            <Button
              variant="quiet"
              size="sm"
              icon={copied === "all" ? <Check /> : <Copy />}
              onClick={() => copy(asText, "all")}
            >
              {copied === "all" ? "Copied" : "Copy all"}
            </Button>
          </div>

          {open && (
            <div className="dns-list">
              {records.map((record) => {
                const id = `${record.kind}:${record.name}`;
                return (
                  <div key={id} className="dns-row">
                    <div className="channel-line">
                      <span className={`pill ${record.required ? "" : "ok"}`}>
                        {record.required ? "required" : "optional"}
                      </span>
                      <span className="pill">{record.kind}</span>
                      {record.priority ? <span className="pill">priority {record.priority}</span> : null}
                    </div>
                    <label>
                      Name
                      <input readOnly value={record.name} onFocus={(e) => e.currentTarget.select()} />
                    </label>
                    <label>
                      Value
                      <input readOnly value={record.value} onFocus={(e) => e.currentTarget.select()} />
                    </label>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={copied === id ? <Check /> : <Copy />}
                      onClick={() => copy(record.value, id)}
                    >
                      {copied === id ? "Copied" : "Copy value"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="row-actions">
        {status !== "failed" && (
          // The tick checks this every minute anyway. This button exists for the person who
          // just pasted three records and wants to know now whether they got them right.
          <form action={recheckAction}>
            <SubmitButton pendingLabel="Asking Amazon…" variant="quiet" size="sm">
              Check now
            </SubmitButton>
          </form>
        )}
        <form action={restartAction}>
          <SubmitButton pendingLabel="Starting again…" variant="quiet" size="sm">
            Start again with new records
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
