import type { ReactNode } from "react";

/**
 * The display pieces every page is built from, beside the controls in kit.tsx.
 *
 * These carry no state and no handlers, so they render on the server and can be dropped
 * into any page without making it a client component. Styling lives in globals.css under
 * "page parts"; a page that needs a variation adds a class there, not a style attribute.
 */

/**
 * Title, one line of what the page is for, and the actions that belong to it. Every page
 * opens with this, so the primary button is always in the same corner and the title is
 * always the same size.
 */
export function PageHead({
  title,
  sub,
  actions,
  lead,
  meta,
}: {
  title: ReactNode;
  /** One sentence. Anything longer belongs on the thing it explains. */
  sub?: ReactNode;
  actions?: ReactNode;
  /** Sits left of the title: an avatar on a person, a logo on a connection. */
  lead?: ReactNode;
  /** A line of facts or tags under the sub. */
  meta?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        {lead}
        <div className="page-head-text">
          <h1>{title}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
          {meta ? <div className="page-head-meta">{meta}</div> : null}
        </div>
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </header>
  );
}

/** Two letters from a name, one pair from a single word — never an empty circle. */
export function initialsOf(name: string): string {
  const parts = name.replace(/[<(@].*$/, "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  const last = parts[parts.length - 1] ?? first;
  const letters = parts.length > 1 ? `${first[0]}${last[0]}` : first.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A person's initials in a grey circle. Grey on purpose: colour on this console means a
 * state, and a face is not one.
 */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`face ${size === "md" ? "" : size}`} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/**
 * Who a row is about: initials, name, and one line under it (role, company, email). The
 * name is the link when there is somewhere to go.
 */
export function Ident({
  name,
  sub,
  href,
  size = "md",
}: {
  name: string;
  sub?: ReactNode;
  href?: string;
  size?: "sm" | "md";
}) {
  const body = (
    <>
      <Avatar name={name} size={size} />
      <span className="ident-text">
        <span className="ident-name">{name}</span>
        {sub ? <span className="ident-sub">{sub}</span> : null}
      </span>
    </>
  );
  return href ? (
    <a className="ident" href={href}>
      {body}
    </a>
  ) : (
    <span className="ident">{body}</span>
  );
}

/**
 * A white card with a title bar. Use it to group one subject on a long page; a page made
 * of nothing but these has lost its hierarchy, so plain headed sections are still fine.
 */
export function Box({
  title,
  sub,
  actions,
  flush = false,
  children,
  className,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** No inner padding — for a table or a list that brings its own. */
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={["box", className].filter(Boolean).join(" ")}>
      {title || actions ? (
        <header className="box-head">
          <div className="box-title">
            {title ? <h2>{title}</h2> : null}
            {sub ? <p className="sub">{sub}</p> : null}
          </div>
          {actions ? <div className="box-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={flush ? "box-body flush" : "box-body"}>{children}</div>
    </section>
  );
}

/**
 * Nothing here yet — said with an icon, one line, and the action that fixes it. An empty
 * state with no way forward is a dead end.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <span className="empty-icon">{icon}</span> : null}
      <strong>{title}</strong>
      {children ? <span className="empty-body">{children}</span> : null}
      {action ? <span className="empty-actions">{action}</span> : null}
    </div>
  );
}

/** A number with its label, and optionally what it means. */
export function Stat({
  label,
  value,
  note,
  icon,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
  /** Only when the number is itself a state: good for a result, bad for a failure. */
  tone?: "good" | "bad" | "warm";
}) {
  return (
    <div className={tone ? `stat-tile ${tone}` : "stat-tile"}>
      <span className="stat-label">
        {icon}
        {label}
      </span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}
