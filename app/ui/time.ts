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

/**
 * Date and time are formatted apart and then joined, rather than by one formatter.
 *
 * The date wants to stay ISO — a table of a hundred rows is scanned down a column, and
 * `2026-09-09` sorts by eye where `09/09/2026` does not. The time wants a meridiem, because
 * `18:08` is a small translation everybody reading a queue has to do, and at a glance
 * `06:08` in the wrong half of the day is a message you thought went out this morning.
 * No locale gives both, so each half gets the locale that spells it the way it is read.
 */
const dateHalf = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeHalf = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

/** The same instant spelled out, for a tooltip where there is room to be unambiguous. */
const full = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
  hour12: true,
});

type When = Date | string | number | null | undefined;

function parse(value: When): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `2026-09-02 05:36 PM`, in IST. The em dash is what an empty cell should read as. */
export function ist(value: When, empty = "—"): string {
  const date = parse(value);
  if (!date) return empty;
  return `${dateHalf.format(date)} ${timeHalf.format(date)}`;
}

/** `Sep 2, 2026, 5:36 PM IST` — for a `title`, where the zone is worth naming outright. */
export function istLong(value: When): string | undefined {
  const date = parse(value);
  return date ? `${full.format(date)} IST` : undefined;
}

/** `05:36:04 PM` — for a call log, where only the time of day is in question. */
const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: IST_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

/** `09-02` — the date half of a table scanned rather than read, where the year is never the question. */
const shortDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST_ZONE,
  month: "2-digit",
  day: "2-digit",
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

/** `09-02 05:36 PM` — the same two halves as `ist`, without the year. */
export function istShort(value: When, empty = "—"): string {
  const date = parse(value);
  return date ? `${shortDate.format(date)} ${timeHalf.format(date)}` : empty;
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

/**
 * IST is a fixed +05:30 with no daylight saving, which is what makes these two conversions
 * safe to do by arithmetic rather than by formatting round-trips.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * `2026-09-11T18:08` — the value a `datetime-local` input wants, showing IST wall time.
 *
 * The input has no notion of a zone, so it would otherwise display the browser's, and a
 * reviewer in Ahmedabad would be handed a UTC time labelled as their own.
 */
export function istInputValue(value: When): string {
  const date = parse(value);
  if (!date) return "";
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * The instant an IST wall time names, back as UTC — the inverse of `istInputValue`, for
 * reading a `datetime-local` back off a form.
 */
export function fromIstInput(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const asUtc = new Date(`${value.slice(0, 16)}:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return undefined;
  return new Date(asUtc.getTime() - IST_OFFSET_MS);
}
