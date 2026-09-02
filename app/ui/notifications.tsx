"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationRow } from "@/engine/notify.js";
import { Bell, CheckCheck, X } from "lucide-react";
import { Button } from "./kit";

const POLL_MS = 15000;

/**
 * The bell. Colour follows the worst severity present, so a glance is enough to know
 * whether anything is actually wrong.
 */
export default function Notifications({ productId }: { productId: string }) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/notifications?product=${productId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: NotificationRow[] };
      setItems(data.items);
    } catch {
      // A failed poll is not worth surfacing — the next one is fifteen seconds away.
    }
  }, [productId]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    // Coming back to a sleeping tab should show current state immediately, not in 15s.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function dismissAll() {
    setItems([]);
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true, product: productId }),
    });
  }

  async function dismiss(id: string) {
    setItems((current) => current.filter((n) => n.id !== id));
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    });
  }

  const worst = items.some((n) => n.severity === "critical")
    ? "critical"
    : items.some((n) => n.severity === "action")
      ? "action"
      : "good";

  return (
    <div className="bell-wrap" ref={panel}>
      <button
        type="button"
        className={`quiet sm bell ${items.length ? worst : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={items.length ? `${items.length} notifications` : "No notifications"}
      >
        <Bell size={15} />
        {items.length > 0 && <span className="bell-count">{items.length}</span>}
      </button>

      {open && (
        <div className="bell-panel">
          <header>
            <strong>Notifications</strong>
            {items.length > 0 && (
              <Button variant="quiet" size="sm" icon={<CheckCheck />} onClick={dismissAll}>Mark all read</Button>
            )}
          </header>

          {items.length === 0 ? (
            <p className="sub" style={{ margin: 0, padding: "16px 14px" }}>
              Nothing needs you. Things that do — a channel that stops working, messages waiting for review —
              show up here.
            </p>
          ) : (
            <ul>
              {items.map((n) => (
                <li key={n.id} className={n.severity}>
                  <div>
                    <strong>{n.title}</strong>
                    {n.count > 1 && <span className="pill" style={{ marginLeft: 6 }}>×{n.count}</span>}
                    {n.body && <p className="sub" style={{ margin: "2px 0 0" }}>{n.body}</p>}
                    {n.href && <a href={n.href}>Open</a>}
                  </div>
                  <Button variant="quiet" size="sm" icon={<X />} onClick={() => dismiss(n.id)} aria-label="Dismiss" />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
