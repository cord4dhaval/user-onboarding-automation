"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the server component that rendered it, on an interval, while `active` is true.
 *
 * Work that used to block the request now happens on the clock, which is the right trade
 * everywhere except the screen: an import that has not finished leaves a page that was
 * correct when it rendered and is wrong a few seconds later. Rather than pushing updates
 * for one counter, the page asks again while there is something to see and stops the
 * moment there is not.
 */
export default function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);

  return null;
}
