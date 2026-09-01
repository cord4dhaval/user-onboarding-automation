/**
 * Just enough of cron to answer one question: when does this fire next.
 *
 * Five fields in UTC, supporting wildcards, single values, ranges, lists and steps. Not a general
 * implementation — a scheduled routine is defined by that handful of shapes, and a
 * dependency for this much would be a dependency to keep patched forever.
 */

const BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week, Sunday 0
];

/** Expands one field into the set of values it matches. Returns null if unparseable. */
function expand(field: string, [min, max]: [number, number]): Set<number> | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    if (range === undefined) return null;
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (!Number.isInteger(step) || step < 1) return null;

    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((n) => Number.parseInt(n, 10));
      if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b)) return null;
      from = a;
      to = b;
    } else {
      const n = Number.parseInt(range, 10);
      if (!Number.isInteger(n)) return null;
      from = n;
      // A bare number with a step means "from here to the end of the field", which is how
      // `35 */2 * * *` is usually written by hand as `35 5/2 * * *`.
      to = stepText === undefined ? n : max;
    }

    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }

  return values.size ? values : null;
}

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the field was literally `*`, which decides how day-of-month and day-of-week combine. */
  everyDayOfMonth: boolean;
  everyDayOfWeek: boolean;
}

export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const set = expand(parts[i] as string, BOUNDS[i] as [number, number]);
    if (!set) return null;
    sets.push(set);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];

  // Sunday is both 0 and 7 in every cron anyone actually writes.
  if (dayOfWeek.has(7)) dayOfWeek.add(0);

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    everyDayOfMonth: parts[2] === "*",
    everyDayOfWeek: parts[4] === "*",
  };
}

/**
 * The first firing strictly after `after`. Days are skipped whole rather than scanned
 * minute by minute, so a yearly expression costs the same as an hourly one.
 */
export function nextCronRun(expression: string, after: Date = new Date()): Date | null {
  const cron = parseCron(expression);
  if (!cron) return null;

  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);

  for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
    const day = new Date(start.getTime());
    if (dayOffset > 0) {
      day.setUTCDate(day.getUTCDate() + dayOffset);
      day.setUTCHours(0, 0, 0, 0);
    }

    if (!cron.month.has(day.getUTCMonth() + 1)) continue;

    // Standard cron: when both day fields are restricted, either one matching is enough.
    const domHit = cron.dayOfMonth.has(day.getUTCDate());
    const dowHit = cron.dayOfWeek.has(day.getUTCDay());
    const dayHit =
      cron.everyDayOfMonth && cron.everyDayOfWeek
        ? true
        : cron.everyDayOfMonth
          ? dowHit
          : cron.everyDayOfWeek
            ? domHit
            : domHit || dowHit;
    if (!dayHit) continue;

    const firstHour = dayOffset === 0 ? day.getUTCHours() : 0;
    for (let hour = firstHour; hour < 24; hour++) {
      if (!cron.hour.has(hour)) continue;
      const firstMinute = dayOffset === 0 && hour === day.getUTCHours() ? day.getUTCMinutes() : 0;
      for (let minute = firstMinute; minute < 60; minute++) {
        if (!cron.minute.has(minute)) continue;
        const at = new Date(day.getTime());
        at.setUTCHours(hour, minute, 0, 0);
        if (at > after) return at;
      }
    }
  }

  return null;
}
