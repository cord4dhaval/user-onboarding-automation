"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LayoutGrid, Lightbulb, LogOut, Settings } from "lucide-react";
import { logOut } from "../auth-actions";
import { ThemeChoice } from "../theme";
import { SubmitButton } from "./kit";

/**
 * Everything about "you" in one place: who is signed in, how the console is themed, and the
 * way out. These used to sit loose in the top bar, which spent three controls and an email
 * address on something read once a session. Inside a product the menu also holds Ideas and
 * Settings — pages visited now and then, which cost a nav slot each for no daily use.
 */
export default function AccountMenu({
  name,
  email,
  orgName,
  product,
}: {
  name: string;
  email: string;
  orgName?: string;
  /** Set inside a product; `ideas` is false when the loop is switched off (IDEAS_LOOP=off). */
  product?: { id: string; ideas: boolean };
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const base = product ? `/products/${product.id}` : "";
  const links = product
    ? [
        ...(product.ideas ? [{ href: `${base}/ideas`, label: "Ideas", icon: <Lightbulb size={15} /> }] : []),
        { href: `${base}/settings`, label: "Settings", icon: <Settings size={15} /> },
      ]
    : [];
  const current = links.some((l) => pathname.startsWith(l.href));
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
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="acct" ref={wrap}>
      <button
        type="button"
        className="avatar"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        data-current={current || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {initials(name)}
      </button>

      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-id">
            <span className="avatar lg" aria-hidden="true">{initials(name)}</span>
            <div>
              <strong>{name}</strong>
              <span className="acct-email">{email}</span>
              {orgName && <span className="acct-email">{orgName}</span>}
            </div>
          </div>

          <nav className="acct-links">
            <a href="/products" role="menuitem" onClick={() => setOpen(false)}>
              <LayoutGrid size={15} /> Products
            </a>
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                role="menuitem"
                aria-current={pathname.startsWith(l.href) ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                {l.icon} {l.label}
              </a>
            ))}
          </nav>

          <div className="acct-theme">
            <span className="pop-title">Theme</span>
            <ThemeChoice />
          </div>

          <form action={logOut} className="acct-out">
            <SubmitButton variant="quiet" size="sm" icon={<LogOut />} pendingLabel="Signing out">
              Sign out
            </SubmitButton>
          </form>
        </div>
      )}
    </div>
  );
}

/** Two letters from a name, one from a single word — never an empty circle. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  const last = parts[parts.length - 1] ?? first;
  const letters = parts.length > 1 ? `${first[0]}${last[0]}` : first.slice(0, 2);
  return letters.toUpperCase();
}
