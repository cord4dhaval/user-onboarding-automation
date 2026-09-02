"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A hover/focus label for something whose meaning is not obvious from its own words —
 * what a metric counts, what a state implies.
 *
 * Deliberately not a popover: no click, no interactive content inside. A tooltip that
 * holds a link is a trap, because reaching the link dismisses it.
 */
export default function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const bubble = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Centred on the trigger until that would run off the screen, then nudged back inside.
  // A tooltip half off the left edge is worse than no tooltip at all.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const node = bubble.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 10;
    if (rect.left < margin) setShift(margin - rect.left);
    else if (rect.right > window.innerWidth - margin) setShift(window.innerWidth - margin - rect.right);
  }, [open]);

  return (
    <span
      className="tip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span tabIndex={0} aria-describedby={open ? id : undefined} className="tip-trigger">
        {children}
      </span>
      {open && (
        <span
          role="tooltip"
          id={id}
          ref={bubble}
          className={`tip tip-${side}`}
          style={{ transform: `translateX(calc(-50% + ${shift}px))` }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
