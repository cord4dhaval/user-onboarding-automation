"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface CampaignOption {
  key: string;
  name: string;
  count: number;
  /** Built on the server — a client component cannot be handed a URL-building function. */
  href: string;
}

/**
 * The campaign filter, as one control rather than a row of pills.
 *
 * A product with thirty campaigns wrapped the pill row over four lines and pushed the list
 * itself below the fold, so the filter is a menu you search — the same shape whether there
 * are two campaigns or two hundred.
 */
export default function CampaignFilter({
  options,
  current,
  allCount,
  allHref,
}: {
  options: CampaignOption[];
  current?: string;
  allCount: number;
  /** Where "All campaigns" goes — the same list with the campaign filter dropped. */
  allHref: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    wrap.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.key === current);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => o.name.toLowerCase().includes(needle) || o.key.toLowerCase().includes(needle))
    : options;

  return (
    <div className="combo" ref={wrap}>
      <button
        type="button"
        className="combo-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="combo-label">
          {selected ? selected.name : "All campaigns"}
        </span>
        <span className="pill">{selected ? selected.count : allCount}</span>
        <ChevronDown size={15} className="combo-caret" />
      </button>

      {open && (
        <div className="combo-menu" role="listbox">
          <div className="combo-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search campaigns"
              aria-label="Search campaigns"
            />
          </div>

          <div className="combo-list">
            <a href={allHref} className={`combo-item ${!current ? "on" : ""}`} role="option" aria-selected={!current}>
              {!current ? <Check size={14} /> : <span className="combo-tick" />}
              <span className="combo-name">All campaigns</span>
              <span className="muted num">{allCount}</span>
            </a>
            {shown.map((o) => (
              <a
                key={o.key}
                href={o.href}
                className={`combo-item ${current === o.key ? "on" : ""}`}
                role="option"
                aria-selected={current === o.key}
              >
                {current === o.key ? <Check size={14} /> : <span className="combo-tick" />}
                <span className="combo-name">{o.name}</span>
                <span className="muted num">{o.count}</span>
              </a>
            ))}
            {shown.length === 0 && <p className="muted combo-none">No campaign matches that.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
