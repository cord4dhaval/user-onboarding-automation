"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "../../../ui/toast";

/**
 * What the last decision actually changed, said once.
 *
 * A bulk decision redraws the list underneath it, so without this the only way to know
 * whether it worked is to count rows — and when the action matched nothing at all, counting
 * rows was the only way to find that out too. The count comes back on the URL because the
 * decision is a server action that redirects; this raises it as a toast and then takes the
 * parameter off the address bar, so a refresh or a shared link does not re-announce a
 * decision somebody made twenty minutes ago.
 */
export default function DecisionToast() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const push = useToast();
  /** Fires once per navigation carrying a count, not once per render. */
  const announced = useRef<string | null>(null);

  const approved = params.get("approved");
  const rejected = params.get("rejected");

  useEffect(() => {
    const raw = approved ?? rejected;
    if (raw === null) return;
    const key = `${approved === null ? "rejected" : "approved"}:${raw}`;
    if (announced.current === key) return;
    announced.current = key;

    const count = Number(raw);
    const word = approved === null ? "rejected" : "approved";
    if (count === 0) {
      push({
        tone: "info",
        title: "Nothing changed",
        body: "Those messages had already been decided on.",
      });
    } else {
      push({
        tone: "good",
        title: `${count} message${count === 1 ? "" : "s"} ${word}`,
        body:
          word === "approved"
            ? "Back in the send queue — every guardrail still applies at the moment each one sends."
            : "Nothing was sent.",
      });
    }

    const next = new URLSearchParams(params.toString());
    next.delete("approved");
    next.delete("rejected");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [approved, rejected, params, pathname, push, router]);

  return null;
}
