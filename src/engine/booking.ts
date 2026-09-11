import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";
import { notify } from "./notify.js";
import { recordSiteEvent } from "./siteEvents.js";

/**
 * Booking a call, on a calendar we can read and write.
 *
 * The alternative was a link to somebody else's booking page. That page would be on a
 * domain we do not own, so the campaign would never learn that anyone booked, and the
 * two-slot buttons in the mail — the thing that turns "schedule a demo" into a choice of
 * which, not whether — are impossible when the slots live on another site.
 *
 * So the calendar is the connected mailbox's own Google Calendar. Free/busy says what is
 * open; an event insert with a Meet request creates the meeting and Google mails the
 * invite. Both need the calendar scope tier on the connection, which is why every
 * function here reports "no calendar" as an ordinary outcome rather than an error: a
 * mailbox connected before that tier existed still sends mail, it simply cannot offer
 * times.
 *
 * All times are computed in the calendar's own zone. The lead's zone is unknown for most
 * of them — the lead form does not ask, and every person record says UTC — so the page
 * says the zone out loud instead of guessing.
 */

export interface CalendarSettings {
  connectionId: string;
  timezone: string;
  startHour: number;
  endHour: number;
  durationMin: number;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  lookaheadDays: number;
  /** Nothing sooner than this, so a slot in a mail sent at 10:40 is not 11:00 today. */
  minLeadHours: number;
}

export const DEFAULT_CALENDAR: Omit<CalendarSettings, "connectionId"> = {
  timezone: "Asia/Kolkata",
  startHour: 10,
  endHour: 18,
  durationMin: 15,
  weekdays: [1, 2, 3, 4, 5],
  lookaheadDays: 7,
  minLeadHours: 3,
};

export interface Slot {
  start: Date;
  end: Date;
  /** "Thu 11 Sep, 11:00 IST" — what the button says. */
  label: string;
}

export function calendarSettingsFrom(access: Record<string, unknown> | undefined): CalendarSettings | null {
  const raw = (access?.calendar ?? null) as Partial<CalendarSettings> | null;
  if (!raw?.connectionId) return null;
  return { ...DEFAULT_CALENDAR, ...raw, connectionId: String(raw.connectionId) };
}

/* ---------- time zone arithmetic without a library ---------- */

/** Wall-clock parts of an instant in a zone. */
function partsIn(date: Date, timeZone: string): { y: number; m: number; d: number; h: number; min: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(String(p.weekday)) + 1;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), weekday };
}

/** Offset of a zone at an instant, in minutes east of UTC. */
function offsetMinutes(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const name = fmt.formatToParts(date).find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant of a wall-clock time in a zone. Two passes handle the offset changing on that day. */
function instantOf(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, h, min));
  for (let i = 0; i < 2; i += 1) {
    const off = offsetMinutes(guess, timeZone);
    guess = new Date(Date.UTC(y, m - 1, d, h, min) - off * 60_000);
  }
  return guess;
}

function zoneAbbrev(timeZone: string, at: Date): string {
  if (timeZone === "Asia/Kolkata") return "IST";
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at).find((x) => x.type === "timeZoneName")?.value;
  return name ?? timeZone;
}

export function labelFor(start: Date, timeZone: string): string {
  const get = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(start);
  // "Thu 11 Sep, 11:00 IST": weekday first, day before month, month as three letters.
  const day = `${get({ weekday: "short" })} ${get({ day: "numeric" })} ${get({ month: "short" })}`;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(start);
  return `${day}, ${time} ${zoneAbbrev(timeZone, start)}`;
}

/* ---------- Google Calendar ---------- */

async function calendarToken(orgId: string, settings: CalendarSettings): Promise<string | null> {
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(settings.connectionId), orgId });
  const scopes = ((connection?.scopes ?? []) as string[]);
  const hasEvents = scopes.includes("https://www.googleapis.com/auth/calendar.events") || scopes.includes("https://www.googleapis.com/auth/calendar");
  if (!connection || !hasEvents) return null;
  try {
    return await resolveSecret(orgId, settings.connectionId, "booking");
  } catch {
    return null;
  }
}

async function busyRanges(token: string, from: Date, to: Date): Promise<Array<{ start: Date; end: Date }>> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`calendar freeBusy ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { calendars?: { primary?: { busy?: Array<{ start: string; end: string }> } } };
  return (body.calendars?.primary?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

/**
 * The next open slots. Returns [] when there is no calendar to ask, so a mail renders
 * without buttons rather than with buttons that lead nowhere.
 */
export async function slotsFor(orgId: string, settings: CalendarSettings, count = 6, now = new Date()): Promise<Slot[]> {
  const token = await calendarToken(orgId, settings);
  if (!token) return [];

  const from = new Date(now.getTime() + settings.minLeadHours * 3_600_000);
  const to = new Date(now.getTime() + settings.lookaheadDays * 86_400_000);
  let busy: Array<{ start: Date; end: Date }>;
  try {
    busy = await busyRanges(token, from, to);
  } catch {
    return [];
  }
  return slotsFromBusy(busy, settings, count, now);
}

/** The pure half: given what is busy, which times to offer. Testable without a calendar. */
export function slotsFromBusy(busy: Array<{ start: Date; end: Date }>, settings: CalendarSettings, count = 6, now = new Date()): Slot[] {
  const from = new Date(now.getTime() + settings.minLeadHours * 3_600_000);
  const out: Slot[] = [];
  const step = settings.durationMin * 60_000;
  // Offers start on the hour or half hour, and after one is taken the next comes at least
  // two hours later, at most two a day: "17:00 or 17:15" reads as one option, "Thu 17:00 or
  // Fri 10:00" reads as a choice. Booking still checks the exact slot, so nothing is lost.
  const grain = 30 * 60_000;
  const spacing = 2 * 3_600_000;
  for (let dayOffset = 0; dayOffset <= settings.lookaheadDays && out.length < count; dayOffset += 1) {
    const probe = new Date(from.getTime() + dayOffset * 86_400_000);
    const p = partsIn(probe, settings.timezone);
    if (!settings.weekdays.includes(p.weekday)) continue;
    const dayStart = instantOf(p.y, p.m, p.d, settings.startHour, 0, settings.timezone);
    const dayEnd = instantOf(p.y, p.m, p.d, settings.endHour, 0, settings.timezone);
    let onThisDay = 0;
    for (let t = dayStart.getTime(); t + step <= dayEnd.getTime() && out.length < count && onThisDay < 2; t += grain) {
      const start = new Date(t);
      const end = new Date(t + step);
      if (start < from) continue;
      if (busy.some((b) => b.start < end && b.end > start)) continue;
      out.push({ start, end, label: labelFor(start, settings.timezone) });
      onThisDay += 1;
      t += spacing - grain;
    }
  }
  return out;
}

/**
 * Whether one specific time can still be booked: inside hours, on the half hour, far enough
 * out, and free. Asked for the slot a mail offered days ago, which may no longer be among
 * the first few the list would show today and is still perfectly bookable.
 */
export async function isSlotOpen(orgId: string, settings: CalendarSettings, start: Date, now = new Date()): Promise<"open" | "taken" | "invalid" | "no_calendar"> {
  if (Number.isNaN(start.getTime())) return "invalid";
  if (start.getTime() < now.getTime() + settings.minLeadHours * 3_600_000) return "invalid";
  if (start.getTime() > now.getTime() + (settings.lookaheadDays + 1) * 86_400_000) return "invalid";
  const p = partsIn(start, settings.timezone);
  if (!settings.weekdays.includes(p.weekday)) return "invalid";
  if (p.min % 30 !== 0) return "invalid";
  const minutes = p.h * 60 + p.min;
  if (minutes < settings.startHour * 60 || minutes + settings.durationMin > settings.endHour * 60) return "invalid";
  const token = await calendarToken(orgId, settings);
  if (!token) return "no_calendar";
  try {
    const busy = await busyRanges(token, start, new Date(start.getTime() + settings.durationMin * 60_000));
    return busy.length ? "taken" : "open";
  } catch {
    return "no_calendar";
  }
}

/** A booking that is still ahead of us. Someone who booked on Monday and clicks again on Tuesday is shown it, not a second form. */
export function upcomingBooking(person: Record<string, unknown> | null, now = new Date()): Booking | null {
  const b = (person?.booking ?? null) as (Booking & { cancelledAt?: Date }) | null;
  if (!b?.eventId || b.cancelledAt) return null;
  const end = new Date(b.end ?? b.start);
  return end.getTime() > now.getTime() ? b : null;
}

export interface Booking {
  eventId: string;
  meetLink?: string;
  htmlLink?: string;
  start: Date;
  end: Date;
  label: string;
}

/**
 * Creates the meeting and tells the campaign. The slot is re-checked against free/busy
 * first: a mail sent on Tuesday can offer a time that was taken on Wednesday.
 */
export async function book(input: {
  orgId: string;
  productId: string;
  personId: string;
  settings: CalendarSettings;
  start: Date;
  summary: string;
  description: string;
}): Promise<{ ok: true; booking: Booking } | { ok: false; reason: "no_calendar" | "taken" | "no_email" | "failed"; detail?: string }> {
  const db = await getDb();
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(input.personId), orgId: input.orgId });
  const email = String(person?.primaryEmail ?? (person?.identities as Array<{ type?: string; value?: string }> | undefined)?.find((i) => i.type === "email")?.value ?? "");
  if (!person || !email) return { ok: false, reason: "no_email" };

  const token = await calendarToken(input.orgId, input.settings);
  if (!token) return { ok: false, reason: "no_calendar" };

  const end = new Date(input.start.getTime() + input.settings.durationMin * 60_000);
  try {
    const busy = await busyRanges(token, input.start, end);
    if (busy.length) return { ok: false, reason: "taken" };
  } catch (err) {
    return { ok: false, reason: "failed", detail: String((err as Error).message ?? err) };
  }

  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.start.toISOString(), timeZone: input.settings.timezone },
      end: { dateTime: end.toISOString(), timeZone: input.settings.timezone },
      attendees: [{ email }],
      conferenceData: { createRequest: { requestId: `${input.personId}-${input.start.getTime()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } },
      reminders: { useDefault: true },
      guestsCanModify: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { ok: false, reason: "failed", detail: `calendar insert ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const event = (await res.json()) as { id: string; hangoutLink?: string; htmlLink?: string };

  const booking: Booking = { eventId: event.id, meetLink: event.hangoutLink, htmlLink: event.htmlLink, start: input.start, end, label: labelFor(input.start, input.settings.timezone) };
  await db.collection(C.people).updateOne(
    { _id: person._id },
    { $set: { booking: { ...booking, connectionId: input.settings.connectionId, bookedAt: new Date() } } },
  );
  // A booking hands the person to a human. Everything still scheduled for them is skipped
  // — the next chase landing an hour after they picked a time would tell them nobody
  // noticed — and the campaign stays open so the signup check can still close it. Not a
  // check of its own: success requires every check to pass, and a booking is a route to
  // signing up, not a second finish line.
  await db.collection(C.actions).updateMany(
    { orgId: input.orgId, productId: input.productId, personId: input.personId, status: { $in: ["queued", "awaiting_approval", "held"] } },
    { $set: { status: "skipped", skipReason: "booked_call" } },
  );
  await db.collection(C.goalInstances).updateMany(
    { orgId: input.orgId, productId: input.productId, personId: input.personId, status: "active" },
    { $set: { handedOverAt: new Date(), handedOverReason: "booked a call", lastReviewNote: `Booked ${booking.label}; sequence stopped, a person takes it from here.` } },
  );
  // The event is recorded for the record and for any campaign whose finish line is the call.
  await recordSiteEvent(input.personId, "booked", "booking page");
  await notify({
    orgId: input.orgId,
    productId: input.productId,
    severity: "good",
    title: `Call booked: ${booking.label}`,
    body: `${String(person.name ?? email)} picked a time. Invite and Meet link sent from the connected calendar.`,
    href: `/products/${input.productId}/library/${input.personId}`,
    dedupeKey: `booked:${input.personId}:${event.id}`,
  });
  return { ok: true, booking };
}
