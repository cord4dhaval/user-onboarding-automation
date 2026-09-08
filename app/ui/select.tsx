"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  /** A second line under the label, for the thing the label cannot say in three words. */
  hint?: string;
  disabled?: boolean;
}

/**
 * The open menu, positioned against its trigger in the viewport.
 *
 * Rendered through a portal rather than inline, because most of these controls live inside
 * a drawer whose body scrolls: an absolutely positioned menu in a scrolling box is clipped
 * at the box's edge, which is exactly where the last field in a form sits. The portal goes
 * into the dialog when there is one — a menu appended to the body counts as an outside
 * click to Radix, and picking an option would close the drawer under the person's hand.
 */
function ComboMenu({
  triggerRef,
  open,
  onClose,
  id,
  multiselectable,
  minWidth = 300,
  children,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onClose: () => void;
  id: string;
  multiselectable?: boolean;
  minWidth?: number;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, minWidth);
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom;
    // Flip above the trigger only when there is genuinely more room up there.
    setPos(
      below < 260 && rect.top > below
        ? { bottom: window.innerHeight - rect.top + 6, left, width }
        : { top: rect.bottom + 6, left, width },
    );
  }, [triggerRef, minWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    setHost(triggerRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body);
    place();
    window.addEventListener("resize", place);
    // Capture, so a scroll inside the drawer body moves the menu with its trigger.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, triggerRef]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menu.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Escape closes the menu, not the drawer behind it. Caught before the dialog sees it.
      event.stopPropagation();
      event.preventDefault();
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !pos || !host) return null;

  return createPortal(
    <div
      ref={menu}
      className="combo-menu"
      id={id}
      role="listbox"
      aria-multiselectable={multiselectable}
      style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
    >
      {children}
    </div>,
    host,
  );
}

/** The list itself, shared by the single and multiple variants. */
function Options({
  options,
  isChosen,
  onPick,
  query,
  setQuery,
  searchable,
}: {
  options: SelectOption[];
  isChosen: (value: string) => boolean;
  onPick: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  searchable?: boolean;
}) {
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle))
    : options;

  return (
    <>
      {searchable && (
        <div className="combo-search">
          <Search size={14} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Filter the options"
          />
        </div>
      )}
      <div className="combo-list">
        {shown.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={isChosen(option.value)}
            disabled={option.disabled}
            className={`combo-item ${isChosen(option.value) ? "on" : ""}`}
            onClick={() => onPick(option.value)}
          >
            {isChosen(option.value) ? <Check size={14} /> : <span className="combo-tick" />}
            <span className="combo-name">
              {option.label}
              {option.hint && <span className="combo-hint">{option.hint}</span>}
            </span>
          </button>
        ))}
        {shown.length === 0 && <p className="muted combo-none">Nothing matches that.</p>}
      </div>
    </>
  );
}

/**
 * The dropdown, as one control everywhere.
 *
 * A native `<select>` renders in the operating system's chrome, not the product's: it
 * ignores the surface colour, the radius and the type scale, and on Windows it ignores the
 * dark theme entirely, so every form had one control that looked borrowed. It also cannot
 * show a second line under an option, which is where "delivered — this channel never
 * confirms" had to live as a truncated label.
 *
 * The value is carried by a real hidden input, so a form posting to a server action reads
 * it exactly as it read the select, and `submitOnChange` keeps the "pick a filter, see the
 * list" feel without a separate Apply button.
 */
export default function Select({
  name,
  value,
  options,
  placeholder = "Select",
  searchable,
  submitOnChange,
  onValueChange,
  width,
  ariaLabel,
  icon,
}: {
  name?: string;
  value: string;
  options: SelectOption[];
  placeholder?: string;
  /** Adds a filter box above the list. Worth it past about a dozen options. */
  searchable?: boolean;
  /** Submit the form this control sits in as soon as a value is picked. */
  submitOnChange?: boolean;
  onValueChange?: (value: string) => void;
  width?: number | string;
  ariaLabel?: string;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(value);
  const trigger = useRef<HTMLButtonElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const listId = useId();

  // A value that arrives from above — the back button, a reset, a filter cleared
  // elsewhere — has to win over what was picked here, or the two disagree.
  useEffect(() => setCurrent(value), [value]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  function pick(next: string) {
    setCurrent(next);
    close();
    onValueChange?.(next);
    if (submitOnChange && hidden.current) {
      // Written straight to the node rather than waiting for the render, so the value the
      // form serialises is the one just picked.
      hidden.current.value = next;
      hidden.current.form?.requestSubmit();
    }
  }

  const selected = options.find((o) => o.value === current);

  return (
    <div className="combo" style={width ? { width } : undefined}>
      {name && <input ref={hidden} type="hidden" name={name} value={current} readOnly />}

      <button
        ref={trigger}
        type="button"
        className="combo-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span className="combo-label">{selected ? selected.label : placeholder}</span>
        <ChevronDown size={15} className="combo-caret" />
      </button>

      <ComboMenu triggerRef={trigger} open={open} onClose={close} id={listId}>
        <Options
          options={options}
          isChosen={(v) => v === current}
          onPick={pick}
          query={query}
          setQuery={setQuery}
          searchable={searchable}
        />
      </ComboMenu>
    </div>
  );
}

/**
 * The same menu, for a field that takes several values.
 *
 * A native `<select multiple>` asks for ctrl-click, scrolls inside itself, and on touch is
 * close to unusable. One hidden input per chosen value keeps `FormData.getAll(name)` reading
 * exactly what the multiple select used to give the server action.
 */
export function MultiSelect({
  name,
  values,
  options,
  placeholder = "Any",
  searchable,
  width,
  ariaLabel,
}: {
  name: string;
  values: string[];
  options: SelectOption[];
  placeholder?: string;
  searchable?: boolean;
  width?: number | string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>(values);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  // A joined string rather than the array, so a new array of the same values does not
  // re-arm the effect on every render of the form above.
  const signature = values.join(" ");

  useEffect(() => setChosen(signature ? signature.split(" ") : []), [signature]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // The menu stays open while picking: choosing four segments should not mean opening the
  // same menu four times.
  function toggle(value: string) {
    setChosen((c) => (c.includes(value) ? c.filter((v) => v !== value) : [...c, value]));
  }

  const label =
    chosen.length === 0
      ? placeholder
      : chosen.length <= 2
        ? chosen.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ")
        : `${chosen.length} selected`;

  return (
    <div className="combo" style={width ? { width } : undefined}>
      {chosen.map((value) => (
        <input key={value} type="hidden" name={name} value={value} readOnly />
      ))}

      <button
        ref={trigger}
        type="button"
        className="combo-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="combo-label">{label}</span>
        <ChevronDown size={15} className="combo-caret" />
      </button>

      <ComboMenu triggerRef={trigger} open={open} onClose={close} id={listId} multiselectable>
        <Options
          options={options}
          isChosen={(v) => chosen.includes(v)}
          onPick={toggle}
          query={query}
          setQuery={setQuery}
          searchable={searchable}
        />
      </ComboMenu>
    </div>
  );
}
