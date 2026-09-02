"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Detail on demand, anchored to the thing it explains.
 *
 * Used where a full drawer is too much and a tooltip is too little: the breakdown behind a
 * number, the reason behind a state. Unlike a tooltip it can hold links and buttons, so it
 * opens on click and stays until dismissed.
 */
export default function Popover({
  trigger,
  title,
  children,
  align = "start",
  width = 280,
}: {
  trigger: ReactNode;
  title?: string;
  children: ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

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
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="pop-wrap" ref={wrap}>
      <button
        type="button"
        className="pop-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>

      {open && (
        <span className={`pop pop-${align}`} role="dialog" style={{ width }}>
          {title && <span className="pop-title">{title}</span>}
          {children}
        </span>
      )}
    </span>
  );
}
