"use client";

import { usePathname } from "next/navigation";
import { FileText, Home, Inbox, Palette, Plug, Send, Sparkles, Target, Users } from "lucide-react";
import type { ReactNode } from "react";

export interface NavCounts {
  review: number;
}

/**
 * Daily work sits above the rule, setup below it. Tabs implied the sections were equals;
 * they are not — you live in Campaigns and visit Channels twice.
 *
 * Library and Audiences are one destination, and so are Claude, Routines and Logs: those
 * were never separate places, only separate scrolls of the same subject.
 */
const WORK = [
  { href: "", label: "Home", icon: <Home /> },
  { href: "/goals", label: "Campaigns", icon: <Target /> },
  { href: "/library", label: "Audience", icon: <Users /> },
  { href: "/review", label: "Review", icon: <Inbox />, counter: "review" as const },
];

const SETUP = [
  { href: "/templates", label: "Templates", icon: <FileText /> },
  { href: "/brand", label: "Brand", icon: <Palette /> },
  { href: "/channels", label: "Channels", icon: <Send /> },
  { href: "/connections", label: "Connections", icon: <Plug /> },
  { href: "/claude", label: "Claude", icon: <Sparkles /> },
];

export default function Nav({ productId, counts }: { productId: string; counts: NavCounts }) {
  const pathname = usePathname();
  const base = `/products/${productId}`;

  function item(entry: { href: string; label: string; icon: ReactNode; counter?: "review" }) {
    const href = `${base}${entry.href}`;
    // The home tab would otherwise match every child route.
    const active = entry.href === "" ? pathname === base : pathname.startsWith(href);
    const count = entry.counter ? counts[entry.counter] : 0;

    return (
      <a key={entry.href} href={href} aria-current={active ? "page" : undefined}>
        {entry.icon}
        {entry.label}
        {count > 0 && <span className="count">{count}</span>}
      </a>
    );
  }

  return (
    <>
      {WORK.map(item)}
      <div className="group">Configure</div>
      {SETUP.map(item)}
    </>
  );
}
