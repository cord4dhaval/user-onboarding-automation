"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Spinner } from "../../../ui/kit";

/** How long the typing has to stop before the list is asked to redraw. */
const SETTLE_MS = 350;

/**
 * Finding one person in a queue of two hundred.
 *
 * Searches the recipient and the subject together, because the reviewer looking for
 * "kiran" and the one looking for "workspace is ready" are asking the same question of
 * this table — which row do I want — and making them choose a field first is a decision
 * about our schema, not about their work.
 *
 * It is still a real GET form underneath. Every keystroke firing a query would have the
 * list redrawing under the reader's hands, so the search waits for the typing to settle;
 * but the form submits on Enter with no JavaScript at all, which is what keeps the first
 * control anyone reaches for working even when the bundle does not.
 */
export default function SearchBox({
  action,
  hiddenQuery,
  current,
}: {
  /** The list's own path. */
  action: string;
  /**
   * The other filters, already encoded — tab, campaign, channel, page size. A string
   * rather than an object so the debounce effect is not re-armed by a new prop identity
   * on every render of the page above it.
   */
  hiddenQuery: string;
  current: string;
}) {
  const [value, setValue] = useState(current);
  const [pending, start] = useTransition();
  const router = useRouter();
  /** The search the list below is actually showing, so a settle that changes nothing is dropped. */
  const applied = useRef(current);

  // A search that arrives from the URL — a link, the back button, the clear control — has
  // to win over what is in the box, or the two disagree about what the list is showing.
  useEffect(() => {
    setValue(current);
    applied.current = current;
  }, [current]);

  useEffect(() => {
    const next = value.trim();
    if (next === applied.current) return;
    const timer = setTimeout(() => {
      applied.current = next;
      const params = new URLSearchParams(hiddenQuery);
      if (next) params.set("q", next);
      const query = params.toString();
      start(() => router.push(query ? `${action}?${query}` : action));
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value, action, hiddenQuery, router]);

  const hidden = [...new URLSearchParams(hiddenQuery).entries()];

  return (
    <form
      className="search"
      role="search"
      action={action}
      onSubmit={(event) => {
        // Enter while the debounce is still counting: take it as "now" rather than making
        // the page reload to say the same thing.
        event.preventDefault();
        applied.current = value.trim();
        const params = new URLSearchParams(hiddenQuery);
        if (value.trim()) params.set("q", value.trim());
        const query = params.toString();
        start(() => router.push(query ? `${action}?${query}` : action));
      }}
    >
      {hidden.map(([name, hiddenValue]) => (
        <input key={name} type="hidden" name={name} value={hiddenValue} readOnly />
      ))}
      {pending ? <Spinner /> : <Search size={14} />}
      <input
        type="search"
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search name, email or subject"
        aria-label="Search messages by recipient or subject"
      />
      {value ? (
        <button type="button" className="search-clear" onClick={() => setValue("")} aria-label="Clear search">
          <X size={14} />
        </button>
      ) : null}
    </form>
  );
}
