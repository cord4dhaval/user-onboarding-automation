"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Spinner } from "./kit";

/** How long the typing has to stop before the list is asked to redraw. */
const SETTLE_MS = 350;

/**
 * The search box in a filter row, applied as you type.
 *
 * Every keystroke firing a query would have the list redrawing under the reader's hands, so
 * it waits for the typing to settle and then submits the form it sits in — which means the
 * other filters travel with it and no URL is assembled by hand. Enter still submits
 * immediately, and with no JavaScript at all this is a plain input in a GET form.
 */
export default function FilterSearch({
  name = "q",
  defaultValue = "",
  placeholder,
  ariaLabel,
  width = 320,
}: {
  name?: string;
  defaultValue?: string;
  placeholder: string;
  ariaLabel?: string;
  width?: number | string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  /** What the list below is actually showing, so a settle that changes nothing is dropped. */
  const applied = useRef(defaultValue);

  useEffect(() => {
    setValue(defaultValue);
    applied.current = defaultValue;
  }, [defaultValue]);

  useEffect(() => {
    const next = value.trim();
    if (next === applied.current.trim()) return;
    const timer = setTimeout(() => {
      applied.current = next;
      start(() => input.current?.form?.requestSubmit());
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  return (
    <div className="filter-search" style={{ width }}>
      {pending ? <Spinner /> : <Search size={15} />}
      <input
        ref={input}
        name={name}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
      />
    </div>
  );
}
