"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCheck, ChevronLeft, ChevronRight, Flame, RotateCcw, X } from "lucide-react";
import { Button, SubmitButton } from "../../../ui/kit";
import { BusyLink, BusySelect } from "../../../ui/busy";
import { decide, heldMessage, returnToReview, type HeldMessage } from "../../../actions";
import MessagePanel from "./message-panel";
import { Avatar, Engagement, type QueueRow } from "./queue-row";

interface Pager {
  first: number;
  last: number;
  total: number;
  current: number;
  pages: number;
  prevHref: string;
  nextHref: string;
  per: number;
  perOptions: Array<{ value: string; label: string; href: string }>;
}

/**
 * The review queue as an inbox: messages down the left, the one picked open on the right.
 *
 * A table of seven columns put the subject in a narrow cell, the preview behind a drawer
 * and the decision off the right edge of the screen. Here a reviewer reads the list, reads
 * the message, and decides, without scrolling sideways or opening anything — and moves on
 * with J and K, or A and R, the way mail clients have trained everyone to.
 */
export default function ReviewQueue({
  productId,
  rows,
  back,
  grouped,
  selectable,
  pager,
  filters,
}: {
  productId: string;
  rows: QueueRow[];
  back: string;
  /** Whether just-engaged people are lifted into their own group. */
  grouped: boolean;
  /** Whether this view has a bulk decision to offer. */
  selectable: "decide" | "return" | false;
  pager: Pager;
  /** Search, campaign and channel, rendered by the page and shown at the head of the list. */
  filters: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(rows[0]?.id);
  /** Narrow screens only, where the message covers the list rather than sitting beside it. */
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const lastIndex = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The queue fills the window from wherever it starts down to the bottom edge, so the page
  // itself never scrolls: the list scrolls inside its column and the message inside its
  // panel, and the decision bar is on screen from the first paint. How far down it starts
  // depends on the nav and on how the tabs wrap, so it is measured rather than assumed.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    function fill() {
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // A measured value, so it is set on the element rather than written as a class.
      el.style.setProperty("--rq-h", `${Math.max(540, Math.floor(window.innerHeight - top - 10))}px`);
    }
    fill();
    window.addEventListener("resize", fill);
    return () => window.removeEventListener("resize", fill);
  }, []);

  const index = rows.findIndex((r) => r.id === selectedId);
  const row = index >= 0 ? rows[index] : undefined;

  useEffect(() => {
    if (index >= 0) lastIndex.current = index;
  }, [index]);

  // A decision redraws the list without the row it acted on. The selection lands on the
  // row that took its place, so approving walks down the queue instead of jumping to the top.
  useEffect(() => {
    if (rows.some((r) => r.id === selectedId)) return;
    setSelectedId(rows[Math.min(lastIndex.current, rows.length - 1)]?.id);
  }, [rows, selectedId]);

  // Ticks on rows that are no longer on the page cannot be acted on, so they are dropped.
  useEffect(() => {
    setChecked((prev) => {
      const here = new Set(rows.map((r) => r.id));
      const kept = [...prev].filter((id) => here.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [rows]);

  // Messages are fetched on pick and kept, so going back to one is free. Rendering a
  // template is a server round trip, so the next row is fetched as soon as this one lands.
  const cache = useRef(new Map<string, Promise<HeldMessage | null>>());
  const [loaded, setLoaded] = useState<{ id: string; message: HeldMessage | null; failed?: string }>();
  const [version, setVersion] = useState(0);

  const load = useCallback((id: string) => {
    let pending = cache.current.get(id);
    if (!pending) {
      pending = heldMessage(id);
      cache.current.set(id, pending);
      pending.catch(() => cache.current.delete(id));
    }
    return pending;
  }, []);

  const nextId = index >= 0 ? rows[index + 1]?.id : undefined;
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    load(selectedId).then(
      (message) => {
        if (!live) return;
        setLoaded({ id: selectedId, message });
        if (nextId) load(nextId).catch(() => undefined);
      },
      (error: unknown) => {
        if (live) {
          setLoaded({
            id: selectedId,
            message: null,
            failed: error instanceof Error ? error.message : "The server did not answer.",
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [selectedId, nextId, version, load]);

  const pick = useCallback((id: string) => {
    setSelectedId(id);
    setOpen(true);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }, []);

  const move = useCallback(
    (step: number) => {
      const target = rows[Math.min(Math.max(index + step, 0), rows.length - 1)];
      if (target) pick(target.id);
    },
    [rows, index, pick],
  );

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      // Typing in a field, a menu or a dialog is never a shortcut.
      if (target?.closest("input:not([type=checkbox]), textarea, select, [contenteditable=true], [role=listbox]:not(.rq-rows), [role=dialog]")) return;
      if (document.querySelector("[role=dialog]")) return;

      const key = event.key.toLowerCase();
      if (key === "j") move(1);
      else if (key === "k") move(-1);
      else if (key === "x" && selectable && selectedId) toggle(selectedId);
      else if (key === "a" || key === "r") {
        // Clicks the button rather than calling the action, so a shortcut can only do what
        // the visible, loaded, enabled control would.
        const button = paneRef.current?.querySelector<HTMLButtonElement>(
          `button[data-decision="${key === "a" ? "approve" : "reject"}"]`,
        );
        if (!button || button.disabled) return;
        button.click();
      } else if (event.key === "Escape") {
        if (checked.size > 0) setChecked(new Set());
        else setOpen(false);
      } else return;
      event.preventDefault();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [move, toggle, selectable, selectedId, checked.size]);

  const allChecked = rows.length > 0 && checked.size === rows.length;
  const picked = rows.filter((r) => checked.has(r.id));
  const dueNow = picked.filter((r) => r.dueNow).length;
  const later = picked.length - dueNow;
  const returnable = picked.filter((r) => r.recoverable);
  const firstCalm = grouped ? rows.findIndex((r) => !r.lifted) : -1;
  const liftedCount = grouped ? rows.filter((r) => r.lifted).length : 0;

  return (
    <div ref={rootRef} className={`rq ${open ? "open" : ""} ${checked.size > 0 ? "selecting" : ""}`}>
      <div className="rq-list">
        <div className="rq-filters">{filters}</div>
        <div className="rq-list-head">
          {selectable ? (
            <input
              type="checkbox"
              className="rq-check-all"
              aria-label="Select every message on this page"
              checked={allChecked}
              ref={(box) => {
                if (box) box.indeterminate = checked.size > 0 && !allChecked;
              }}
              onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
            />
          ) : null}
          <span>
            {checked.size > 0 ? `${checked.size} selected` : `${pager.first}–${pager.last} of ${pager.total}`}
          </span>
          <span className="spacer" />
          <span className="rq-keys muted">
            <kbd>J</kbd>
            <kbd>K</kbd>
          </span>
        </div>

        <div className="rq-rows" ref={listRef} role="listbox" aria-label="Messages">
          {rows.map((r, i) => {
            const on = r.id === selectedId;
            const ticked = checked.has(r.id);
            return (
              <div key={r.id} className="rq-slot">
                {grouped && i === 0 && liftedCount > 0 ? (
                  <div className="rq-group hot">
                    <Flame /> Just engaged · {liftedCount}
                  </div>
                ) : null}
                {grouped && i === firstCalm && firstCalm > 0 ? <div className="rq-group">Up next</div> : null}
                <div
                  data-id={r.id}
                  role="option"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  className={`rq-row ${on ? "on" : ""} ${ticked ? "ticked" : ""}`}
                  onClick={() => pick(r.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      move(event.key === "ArrowDown" ? 1 : -1);
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      pick(r.id);
                    }
                  }}
                >
                  <span className="rq-lead">
                    <Avatar name={r.name} hot={r.lifted} />
                    {selectable ? (
                      <input
                        type="checkbox"
                        className="rq-check"
                        aria-label={`Select the message to ${r.name}`}
                        checked={ticked}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => toggle(r.id)}
                      />
                    ) : null}
                  </span>
                  <span className="rq-main">
                    <span className="rq-top">
                      <strong className="rq-name">{r.name}</strong>
                      <span className={`rq-when ${r.decidable && r.dueNow ? "due" : ""}`} title={r.whenLong}>
                        {r.decidable && r.dueNow ? "Due now" : r.whenShort}
                      </span>
                    </span>
                    {r.subject ? (
                      <span className="rq-subject">{r.subject}</span>
                    ) : r.opening ? (
                      <span className="rq-subject">“{r.opening}”</span>
                    ) : (
                      <span className="rq-subject soft">Template default — open to see which</span>
                    )}
                    <span className="rq-meta">
                      {!r.decidable ? <span className={`pill ${r.state.tone}`}>{r.state.label}</span> : null}
                      <Engagement row={r} />
                      <span className="rq-campaign">{r.campaign}</span>
                    </span>
                    {!r.decidable && r.state.detail ? (
                      <span className="state-why" title={r.state.detail}>
                        {r.state.detail}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="rq-pager">
          <BusySelect
            value={String(pager.per)}
            options={pager.perOptions}
            width={100}
            ariaLabel="Messages per page"
          />
          <span className="spacer" />
          <span className="muted num">
            {pager.current} / {pager.pages}
          </span>
          <BusyLink
            href={pager.prevHref}
            className={`btn ghost sm ${pager.current === 1 ? "off" : ""}`}
            disabled={pager.current === 1}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </BusyLink>
          <BusyLink
            href={pager.nextHref}
            className={`btn ghost sm ${pager.current === pager.pages ? "off" : ""}`}
            disabled={pager.current === pager.pages}
            aria-label="Next page"
          >
            <ChevronRight />
          </BusyLink>
        </div>
      </div>

      <div className="rq-side" ref={paneRef}>
        {row ? (
          <MessagePanel
            key={row.id}
            productId={productId}
            row={row}
            message={loaded?.id === row.id ? loaded.message : undefined}
            failed={loaded?.id === row.id ? loaded.failed : undefined}
            back={back}
            position={`${index + 1} of ${rows.length}`}
            onPrev={index > 0 ? () => move(-1) : undefined}
            onNext={index < rows.length - 1 ? () => move(1) : undefined}
            onClose={() => setOpen(false)}
            onChanged={() => {
              cache.current.delete(row.id);
              setVersion((v) => v + 1);
            }}
          />
        ) : null}
      </div>

      {/* Floats over the page rather than sitting in the header, so it is where the eye is
          the moment the first box is ticked, and says exactly what it will release. */}
      {checked.size > 0 && selectable ? (
        <div className="rq-bulk" role="region" aria-label="Selected messages">
          <strong>{checked.size} selected</strong>
          {selectable === "decide" ? (
            <form action={decide} className="rq-bulk-form">
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="back" value={back} />
              {picked.map((r) => (
                <input key={r.id} type="hidden" name="ids" value={r.id} />
              ))}
              <SubmitButton name="decision" value="approve" size="sm" icon={<CheckCheck />} pendingLabel="Approving…">
                {later === 0
                  ? `Approve — sends ${dueNow} now`
                  : dueNow === 0
                    ? `Approve — ${later} on their dates`
                    : `Approve — ${dueNow} now, ${later} later`}
              </SubmitButton>
              <SubmitButton name="decision" value="reject" variant="quiet" size="sm" icon={<X />} pendingLabel="Rejecting…">
                Reject
              </SubmitButton>
            </form>
          ) : returnable.length > 0 ? (
            <form action={returnToReview} className="rq-bulk-form">
              <input type="hidden" name="productId" value={productId} />
              {returnable.map((r) => (
                <input key={r.id} type="hidden" name="ids" value={r.id} />
              ))}
              <SubmitButton variant="quiet" size="sm" icon={<RotateCcw />} pendingLabel="Returning…">
                Return {returnable.length} to review
              </SubmitButton>
            </form>
          ) : (
            <span className="muted">None of these can go back to review.</span>
          )}
          <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())} aria-label="Clear selection">
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}
