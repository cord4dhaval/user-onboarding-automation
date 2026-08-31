/** Local hour for an IANA timezone, without pulling in a date library. */
export function localHour(at: Date, timezone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(at);
    return Number.parseInt(hour, 10) % 24;
  } catch {
    return at.getUTCHours();
  }
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
  const hour = localHour(now, timezone);

  const inQuiet =
    startQuiet <= endQuiet
      ? hour >= startQuiet && hour < endQuiet
      : hour >= startQuiet || hour < endQuiet;
  if (!inQuiet) return now;

  const hoursUntilOpen = (endQuiet - hour + 24) % 24;
  return new Date(now.getTime() + hoursUntilOpen * 3_600_000);
}
