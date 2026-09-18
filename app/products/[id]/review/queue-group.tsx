"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../../../ui/kit";

/**
 * One band of the review queue: people who just responded, mail due now, mail dated later.
 *
 * The queue was one list with a paragraph above it explaining that the first few rows were
 * different. A heading says the same thing where the difference starts, and the band's own
 * Approve releases exactly the rows under it — so "approve the hot ones" is one click rather
 * than six, and never the whole page by accident.
 */
export default function QueueGroup({
  title,
  total,
  why,
  tone,
  defaultOpen = true,
  shown,
  action,
  children,
}: {
  title: string;
  /** How many the whole queue holds in this band, under the current filters. */
  total: number;
  why: string;
  tone?: "hot";
  defaultOpen?: boolean;
  /** How many of them are on this page. */
  shown: number;
  /** The band's bulk decision, rendered by the page so it posts to the server action. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useId();
  const rest = total - shown;

  return (
    <section className="q-group" aria-label={title}>
      <div className="q-group-head">
        <Button
          variant="ghost"
          size="sm"
          className="q-toggle"
          icon={open ? <ChevronDown /> : <ChevronRight />}
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen(!open)}
        >
          {title}
        </Button>
        <span className={`pill ${tone ?? ""}`}>{total}</span>
        <span className="q-group-why">
          {why}
          {rest > 0 ? ` · ${shown} on this page` : ""}
        </span>
        {open && action ? <span className="q-group-act">{action}</span> : null}
        {!open ? (
          <span className="q-group-act">
            <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
              Show {shown}
            </Button>
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="q-group-body" id={body}>
          {children}
          {rest > 0 ? <p className="q-more">{rest} more on other pages</p> : null}
        </div>
      ) : null}
    </section>
  );
}
