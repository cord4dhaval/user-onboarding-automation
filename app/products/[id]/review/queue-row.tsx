"use client";

import { MessageSquare, MousePointerClick } from "lucide-react";

/**
 * One message as the list needs it, flattened on the server.
 *
 * Every string a row shows is worked out there — times in IST, "28 hours ago", the state
 * and its reason — so the browser renders exactly what the server did and nothing drifts
 * between the two on hydration.
 */
export interface QueueRow {
  id: string;
  name: string;
  email: string;
  campaign: string;
  angle: string;
  channel: string;
  /** Which mailbox it leaves from, as a label. */
  sender: string;
  /** The From header itself, for the inbox preview; absent when the provider picks. */
  from?: string;
  subject?: string;
  /** The opening Claude wrote, when the subject still comes from the template. */
  opening?: string;
  /** Whether the row still carries the decision. */
  decidable: boolean;
  whenShort: string;
  whenLong?: string;
  dueNow: boolean;
  /** Someone who has just clicked or written back, lifted to the top of the queue. */
  lifted: boolean;
  band?: string;
  replied: boolean;
  clicked: boolean;
  /** How long ago they last did either, in words. */
  engagedAgo: string;
  state: { label: string; tone: string; detail?: string; origin?: string };
  recoverable: boolean;
}

export function Avatar({ name, hot }: { name: string; hot?: boolean }) {
  const letters = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className={`rq-avatar ${hot ? "hot" : ""}`} aria-hidden="true">
      {letters || "?"}
    </span>
  );
}

/**
 * What this person has already done about us. Silent when they have done nothing: "no
 * response yet" printed on forty rows of forty is a column of noise hiding the three that
 * say something.
 */
export function Engagement({ row }: { row: QueueRow }) {
  if (row.replied) {
    return (
      <span className="pill ok" title={`replied ${row.engagedAgo}`}>
        <MessageSquare /> replied {row.engagedAgo}
      </span>
    );
  }
  if (row.clicked) {
    return (
      <span className="pill hot" title={`clicked ${row.engagedAgo}`}>
        <MousePointerClick /> clicked {row.engagedAgo}
      </span>
    );
  }
  return row.band && row.band !== "cold" ? <span className={`pill ${row.band}`}>{row.band}</span> : null;
}
