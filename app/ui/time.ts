/**
 * Every timestamp the console shows, in one place.
 *
 * The rule this enforces: **UTC everywhere in logic, IST everywhere on screen.** Dates are
 * stored, compared, windowed and sorted as UTC instants — a rolling 24-hour cap cannot be
 * reasoned about in a local calendar — and are converted to Asia/Kolkata only at the moment
 * they are rendered.
 *
 * The zone is pinned rather than read from the machine. These strings are produced on the
 * server and then hydrated in the browser, so a formatter that consulted the ambient
 * timezone would render one string in Vercel's UTC container and a different one in the
 * reader's browser, and React would discard the markup on mismatch.
 */
const IST_ZONE = "Asia/Kolkata";

/** ISO-ish and sortable by eye, which a table of a hundred rows needs more than prose. */
const stamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The same instant spelled out, for a tooltip where there is room to be unambiguous. */
const full = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

type When = Date | string | number | null | undefined;

function parse(value: When): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `2026-09-02 17:36`, in IST. The em dash is what an empty cell should read as. */
export function ist(value: When, empty = "—"): string {
  const date = parse(value);
  if (!date) return empty;
  return stamp.format(date).replace(", ", " ");
}

/** `2 Sept 2026, 17:36 IST` — for a `title`, where the zone is worth naming outright. */
export function istLong(value: When): string | undefined {
  const date = parse(value);
  return date ? `${full.format(date)} IST` : undefined;
}

/** `17:36:04` — for a call log, where only the time of day is in question. */
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** `09-02 17:36` — a table scanned rather than read, where the year is never the question. */
const shortStamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `2026-09-02` — a date with no time, and the key days are bucketed by. */
const dayStamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `2 Sept` — an axis label, where the year is carried by the axis itself. */
const axisDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST_ZONE,
  day: "numeric",
  month: "short",
});

export function istClock(value: When, empty = "—"): string {
  const date = parse(value);
  return date ? clock.format(date) : empty;
}

export function istShort(value: When, empty = "—"): string {
  const date = parse(value);
  return date ? shortStamp.format(date).replace(", ", " ") : empty;
}

/**
 * The IST calendar day an instant falls on.
 *
 * Bucketing a chart by UTC day puts anything sent after 05:30 IST in the wrong column for
 * a reader in India — which is most of the working day.
 */
export function istDay(value: When, empty = "—"): string {
  const date = parse(value);
  return date ? dayStamp.format(date) : empty;
}

export function istAxisDay(value: When): string {
  const date = parse(value);
  return date ? axisDay.format(date) : "";
}
