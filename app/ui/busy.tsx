"use client";

import { createContext, useCallback, useContext, useMemo, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "./kit";

interface BusyState {
  busy: boolean;
  go: (href: string) => void;
}

const Ctx = createContext<BusyState | null>(null);

/**
 * Navigation that says what it is doing.
 *
 * A paged table is served by the server, so turning a page is a round trip. Rendered as a
 * plain anchor it is a full document navigation: nothing changes on screen until the new
 * page arrives, and on a list of 500 rows over a slow query that reads as a dead click —
 * so people click again, and again. Routing through a transition gives an exact pending
 * signal.
 */
export function BusyProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  const go = useCallback((href: string) => startTransition(() => router.push(href)), [router]);

  const value = useMemo<BusyState>(() => ({ busy, go }), [busy, go]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useBusy(): BusyState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("BusyLink and BusyArea must be inside a BusyProvider");
  return ctx;
}

/**
 * A link that reports itself as loading. Still a real anchor: middle-click, copy link and
 * open-in-new-tab all keep working, and the transition only takes over a plain left click.
 */
export function BusyLink({
  href,
  className,
  disabled,
  onClick,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className">) {
  const { go } = useBusy();
  return (
    <a
      {...rest}
      href={href}
      className={className}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        // The caller's handler runs first and can still cancel — a menu closing itself on
        // pick is the common case, and it must not replace the navigation.
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (disabled) {
          event.preventDefault();
          return;
        }
        // Anything but a plain left click is the reader asking for a new tab or window.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        go(href);
      }}
    >
      {children}
    </a>
  );
}

/** A `<select>` that navigates on change, with the same pending signal as a BusyLink. */
export function BusySelect({
  value,
  options,
  name,
}: {
  value: string;
  options: Array<{ value: string; label: string; href: string }>;
  name?: string;
}) {
  const { go } = useBusy();
  return (
    <select
      name={name}
      value={value}
      onChange={(event) => {
        const picked = options.find((o) => o.value === event.target.value);
        if (picked) go(picked.href);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/**
 * The region a navigation replaces, veiled while the next one loads.
 *
 * The old content stays visible underneath rather than being swapped for a skeleton: it is
 * still the truth until the new page arrives, and a reader mid-sentence does not lose it.
 */
export function BusyArea({ children }: { children: ReactNode }) {
  const { busy } = useBusy();
  return (
    <div className="busy" aria-busy={busy}>
      {children}
      {busy ? (
        <div className="busy-veil">
          {/* Sticky rather than centred on the region: a hundred rows are taller than the
              window, and the true centre of that block is somewhere nobody is looking. */}
          <span className="busy-spin" role="status" aria-label="Loading">
            <Spinner size={22} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
