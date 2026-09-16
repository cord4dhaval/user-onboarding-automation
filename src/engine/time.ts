/** Local wall-clock hour, minute and second for an IANA timezone, without a date library. */
function localClock(at: Date, timezone: string): { hour: number; minute: number; second: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    }).formatToParts(at);
    const part = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    return { hour: part("hour") % 24, minute: part("minute"), second: part("second") };
  } catch {
    return { hour: at.getUTCHours(), minute: at.getUTCMinutes(), second: at.getUTCSeconds() };
  }
}

/** Local hour for an IANA timezone, without pulling in a date library. */
export function localHour(at: Date, timezone: string): number {
  return localClock(at, timezone).hour;
}

/**
 * A lead who just filled in a form is at their keyboard, so a real-time first touch goes
 * out at 11pm and should. A bulk import at 11pm is not urgency — it is just when the file
 * was uploaded — so those wait for a civil hour in the recipient's own timezone.
 */
export function nextSendableAt(
  now: Date,
  timezone: string,
  triggerMode: "realtime" | "batch",
  quietHours?: [number, number],
): Date {
  if (triggerMode === "realtime") return now;

  const [startQuiet, endQuiet] = quietHours ?? [21, 8];
  const clock = localClock(now, timezone);
  const hour = clock.hour;

  const inQuiet =
    startQuiet <= endQuiet
      ? hour >= startQuiet && hour < endQuiet
      : hour >= startQuiet || hour < endQuiet;
  if (!inQuiet) return now;

  // To the top of the opening hour, not the same minute past it. Adding whole hours to an
  // upload at 05:50 opened the window at 08:50, so every lead in the batch waited most of an
  // hour for nothing. Minutes are read locally because some zones sit on a half hour.
  const hoursUntilOpen = (endQuiet - hour + 24) % 24;
  const intoHour = (clock.minute * 60 + clock.second) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() + hoursUntilOpen * 3_600_000 - intoHour);
}

/** Where a person is assumed to be when nothing on their row says otherwise: this product's own market. */
export const HOME_TIMEZONE = "Asia/Kolkata";

/**
 * International dialling codes, to the zone most of that country's people live in. ITU codes
 * are prefix-free, so trying three digits, then two, then one can never pick the wrong one.
 */
const ZONE_BY_DIAL_CODE: Record<string, string> = {
  "1": "America/New_York",
  "7": "Europe/Moscow",
  "20": "Africa/Cairo",
  "27": "Africa/Johannesburg",
  "31": "Europe/Amsterdam",
  "32": "Europe/Brussels",
  "33": "Europe/Paris",
  "34": "Europe/Madrid",
  "39": "Europe/Rome",
  "41": "Europe/Zurich",
  "44": "Europe/London",
  "46": "Europe/Stockholm",
  "49": "Europe/Berlin",
  "52": "America/Mexico_City",
  "55": "America/Sao_Paulo",
  "60": "Asia/Kuala_Lumpur",
  "61": "Australia/Sydney",
  "62": "Asia/Jakarta",
  "63": "Asia/Manila",
  "64": "Pacific/Auckland",
  "65": "Asia/Singapore",
  "66": "Asia/Bangkok",
  "81": "Asia/Tokyo",
  "82": "Asia/Seoul",
  "84": "Asia/Ho_Chi_Minh",
  "86": "Asia/Shanghai",
  "90": "Europe/Istanbul",
  "91": "Asia/Kolkata",
  "92": "Asia/Karachi",
  "94": "Asia/Colombo",
  "234": "Africa/Lagos",
  "254": "Africa/Nairobi",
  "351": "Europe/Lisbon",
  "353": "Europe/Dublin",
  "852": "Asia/Hong_Kong",
  "880": "Asia/Dhaka",
  "966": "Asia/Riyadh",
  "971": "Asia/Dubai",
  "972": "Asia/Jerusalem",
  "974": "Asia/Qatar",
  "977": "Asia/Kathmandu",
};

/** Country domains that name a country. Generic ones (.com, .io, .co, .ai) say nothing about where anyone is. */
const ZONE_BY_TLD: Record<string, string> = {
  in: "Asia/Kolkata",
  uk: "Europe/London",
  ie: "Europe/Dublin",
  au: "Australia/Sydney",
  nz: "Pacific/Auckland",
  ae: "Asia/Dubai",
  sg: "Asia/Singapore",
  ca: "America/Toronto",
  de: "Europe/Berlin",
  fr: "Europe/Paris",
  nl: "Europe/Amsterdam",
  za: "Africa/Johannesburg",
  my: "Asia/Kuala_Lumpur",
  pk: "Asia/Karachi",
  lk: "Asia/Colombo",
  bd: "Asia/Dhaka",
  np: "Asia/Kathmandu",
};

function isZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a person most likely is, from what a lead list actually carries.
 *
 * A sheet almost never has a timezone column, and defaulting to UTC put an Indian lead's
 * 11:20 in the morning inside UTC's quiet hours: on 16 September a batch of 356 was held
 * three hours for a night that was not theirs. A timezone on the row wins; then the
 * dialling code, which is the strongest hint a list carries; then the address's country
 * domain. A local number with no country code is not read — it could be anywhere.
 */
export function timezoneFor(hints: { timezone?: unknown; phone?: string; email?: string }): string {
  if (isZone(hints.timezone)) return hints.timezone.trim();

  const phone = String(hints.phone ?? "").trim();
  if (/^(\+|00)/.test(phone)) {
    const digits = phone.replace(/^00/, "").replace(/\D/g, "");
    for (const length of [3, 2, 1]) {
      const zone = ZONE_BY_DIAL_CODE[digits.slice(0, length)];
      if (zone) return zone;
    }
  }

  const tld = String(hints.email ?? "").trim().toLowerCase().split(".").pop() ?? "";
  return ZONE_BY_TLD[tld] ?? HOME_TIMEZONE;
}
