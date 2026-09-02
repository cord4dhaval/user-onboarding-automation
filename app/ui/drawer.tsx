"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./kit";

/**
 * A side panel for anything that used to be an inline form.
 *
 * Forms rendered under a list push the list off the screen and make a page do two jobs at
 * once. In a drawer the list stays put, and closing returns you exactly where you were.
 */
export default function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  width = 520,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll while a panel is over it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    panel.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        style={{ width }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p className="sub" style={{ margin: "2px 0 0" }}>{description}</p>}
          </div>
          <Button variant="quiet" size="sm" icon={<X />} onClick={onClose} aria-label="Close" />
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}
