"use client";

import { useFormStatus } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { useToast } from "./toast";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The shared control set. Every button in the console comes from here, so "is it working?"
 * has one answer everywhere: the label is replaced by a spinner and the control locks.
 *
 * Server actions post through a form, so pending state is read from the form itself with
 * useFormStatus rather than tracked by hand in every page.
 */

type Variant = "primary" | "quiet" | "ghost" | "danger" | "destructive";
type Size = "md" | "sm";

function classes(variant: Variant, size: Size, extra?: string): string {
  return [variant === "primary" ? "" : variant, size === "sm" ? "sm" : "", extra]
    .filter(Boolean)
    .join(" ");
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: Variant;
  size?: Size;
  /**
   * A rendered element, not a component. Server components hand these buttons their icons,
   * and a component reference is not serialisable across that boundary — an element is.
   * Size comes from CSS so no call site has to remember a pixel value.
   */
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
}

/** A button that is not submitting a form — dialogs, drawers, client-side toggles. */
export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={classes(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner size={size === "sm" ? 13 : 15} /> : icon}
      {children}
    </button>
  );
}

/**
 * The submit control for any form wired to a server action. While the action is in flight
 * the label is swapped for a spinner, so a slow round trip never looks like a dead click.
 */
export function SubmitButton({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  pendingLabel,
  disabled,
  ...rest
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      {...rest}
      type="submit"
      className={classes(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? <Spinner size={size === "sm" ? 13 : 15} /> : icon}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}

/**
 * A bound server action rendered as a single button. Actions bound with their own
 * arguments ignore the FormData, so the form exists only to give useFormStatus something
 * to watch.
 */
export function ActionButton({
  action,
  children,
  hidden,
  toast,
  ...rest
}: ButtonProps & {
  action: (formData: FormData) => void | Promise<void>;
  pendingLabel?: string;
  hidden?: Record<string, string>;
  /** Raised once the action comes back, for work whose effect is off-screen. */
  toast?: { title: string; body?: string; tone?: "good" | "info" | "bad" };
}) {
  const push = useToast();
  // Wrapping a server action in a client function keeps the pending state and the
  // confirmation in one place, rather than asking every page to track both.
  const submit = toast
    ? async (formData: FormData) => {
        await action(formData);
        push({ tone: toast.tone ?? "good", title: toast.title, body: toast.body });
      }
    : action;

  return (
    <form action={submit} style={{ display: "contents" }}>
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton {...rest}>{children}</SubmitButton>
    </form>
  );
}

/** Section switch inside one page — Library/Audiences, Claude's setup/routines/logs. */
export function Tabs({
  tabs,
  current,
}: {
  tabs: Array<{ key: string; label: string; href: string; icon?: ReactNode; count?: number }>;
  current: string;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <a
          key={t.key}
          href={t.href}
          role="tab"
          aria-selected={t.key === current}
          className={t.key === current ? "on" : undefined}
        >
          {t.icon}
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </a>
      ))}
    </div>
  );
}
