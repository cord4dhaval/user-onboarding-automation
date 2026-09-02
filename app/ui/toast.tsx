"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";

/**
 * Confirmation that something finished.
 *
 * The bell carries state the engine noticed on its own; a toast carries the result of
 * something the person just did. Without it, an action that changes a number three rows
 * down the page reads as no action at all.
 */

type Tone = "good" | "info" | "bad";

interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});

/** Lives in the product layout, so any control on any page can raise one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    // Math.random would be enough, but a counter keyed off the current length collides
    // when two land in the same tick — the timestamp does not.
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 5000);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div className={`toast ${t.tone}`} key={t.id}>
            {t.tone === "good" ? <CircleCheck size={16} /> : t.tone === "bad" ? <TriangleAlert size={16} /> : <Info size={16} />}
            <div>
              <strong>{t.title}</strong>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
