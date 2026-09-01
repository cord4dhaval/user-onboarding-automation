"use client";

import { usePathname } from "next/navigation";

export interface NavCounts {
  review: number;
}

/**
 * Daily work sits above the rule, setup below it. Tabs implied the sections were equals;
 * they are not — you live in Goals and visit Channels twice.
 */
const WORK = [
  { href: "", label: "Home" },
  { href: "/goals", label: "Campaigns" },
  { href: "/library", label: "Library" },
  { href: "/audiences", label: "Audiences" },
  { href: "/review", label: "Review", counter: "review" as const },
];

const SETUP = [
  { href: "/templates", label: "Templates" },
  { href: "/channels", label: "Channels" },
  { href: "/connections", label: "Connections" },
  { href: "/providers", label: "Providers" },
  { href: "/claude", label: "Connect Claude" },
  { href: "/routines", label: "Routines" },
  { href: "/logs", label: "Logs" },
];

export default function Nav({ productId, counts }: { productId: string; counts: NavCounts }) {
  const pathname = usePathname();
  const base = `/products/${productId}`;

  function item(entry: { href: string; label: string; counter?: "review" }) {
    const href = `${base}${entry.href}`;
    // The home tab would otherwise match every child route.
    const active = entry.href === "" ? pathname === base : pathname.startsWith(href);
    const count = entry.counter ? counts[entry.counter] : 0;

    return (
      <a key={entry.href} href={href} aria-current={active ? "page" : undefined}>
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
