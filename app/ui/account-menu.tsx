"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGrid, LogOut } from "lucide-react";
import { logOut } from "../auth-actions";
import { ThemeChoice } from "../theme";
import { SubmitButton } from "./kit";

/**
 * Everything about "you" in one place: who is signed in, how the console is themed, and the
 * way out. These used to sit loose in the top bar, which spent three controls and an email
 * address on something read once a session. Product settings stay in the sidebar — they
 * belong to the product, not the account, and listing them twice made them look like two
 * different pages.
 */
export default function AccountMenu({
  name,
  email,
  orgName,
}: {
  name: string;
  email: string;
  orgName?: string;
}) {
  const [open, setOpen] = useState(false);
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
