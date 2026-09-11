import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { verify } from "@/engine/tracking.js";
import { book, calendarSettingsFrom, isSlotOpen, labelFor, slotsFor, upcomingBooking, type CalendarSettings } from "@/engine/booking.js";

export const dynamic = "force-dynamic";

/**
 * The booking page a mail links to.
 *
 * Unauthenticated, like unsubscribe: the reader has no account here, and the signature in
 * the link stands in for one. It covers the person, so a link can only book for the
 * person it was sent to.
 *
 * GET with a slot shows one confirm button for that time; GET without shows the next
 * open times. POST creates the meeting. A slot that was taken between the mail and the
 * click is met with the next open ones, never an error page.
 */
type Ctx = { orgId: string; productId: string; personId: string; signature: string; settings: CalendarSettings; access: Record<string, unknown> };

async function context(request: NextRequest): Promise<Ctx | NextResponse> {
  const personId = request.nextUrl.searchParams.get("p") ?? "";
  const signature = request.nextUrl.searchParams.get("s") ?? "";
  if (!ObjectId.isValid(personId) || !verify("e", personId, "", signature)) {
    return page("This link is not valid.", "Reply to the email you received and we will send a fresh one.");
  }
  const db = await getDb();
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) }, { projection: { orgId: 1, productId: 1, suppressedAt: 1, booking: 1 } });
  if (!person || person.suppressedAt) return page("This link is not valid.", "Reply to the email you received and we will send a fresh one.");
  const orgId = String(person.orgId);
  const productId = String(person.productId);

  // Already booked and still ahead: show it rather than a second form. The invite in their
  // inbox is the place to move or cancel it, and that is said out loud.
  const existing = upcomingBooking(person as Record<string, unknown>);
  if (existing) {
    return page(
      `You are booked: ${existing.label}`,
      "The invite in your inbox has the Meet link. To move or cancel it, use the invite, or reply to our email.",
      existing.meetLink ? `<p style="margin:16px 0 0;font-size:14px;">Meet link: <a href="${esc(existing.meetLink)}" style="color:#101114;">${esc(existing.meetLink)}</a></p>` : "",
    );
  }

  // The one active access asset with a calendar behind it decides hours, zone and length.
  const asset = await db.collection(C.assets).findOne({ orgId, productId, kind: "access", status: "active", "access.calendar.connectionId": { $exists: true } });
  const settings = calendarSettingsFrom((asset?.access ?? undefined) as Record<string, unknown> | undefined);
  if (!settings) return page("Booking is not open right now.", "Reply to the email with a time that suits you and we will send an invite.");
  return { orgId, productId, personId, signature, settings, access: (asset?.access ?? {}) as Record<string, unknown> };
}

export async function GET(request: NextRequest) {
  const ctx = await context(request);
  if (ctx instanceof NextResponse) return ctx;
  const slotParam = request.nextUrl.searchParams.get("slot");
  const base = `?p=${esc(ctx.personId)}&s=${esc(ctx.signature)}`;

  // A slot named in the link is checked on its own, not against today's first few: the
  // mail may be three days old and its time still perfectly free.
  if (slotParam) {
    const start = new Date(slotParam);
    const state = await isSlotOpen(ctx.orgId, ctx.settings, start);
    if (state === "open") {
      const label = labelFor(start, ctx.settings.timezone);
      return page(
        `Book ${label}?`,
        `A ${ctx.settings.durationMin}-minute call on Google Meet. The invite goes to the address we wrote to. ${availability(ctx)}`,
        `<form method="post" action="${base}" style="margin:24px 0 0;">
<input type="hidden" name="slot" value="${esc(start.toISOString())}" />
<button type="submit" style="${BTN}">Book this time</button>
<p style="margin:16px 0 0;font-size:14px;"><a href="${base}" style="color:#101114;">Pick a different time</a></p>
</form>${localTime(start)}`,
      );
    }
    const slots = await slotsFor(ctx.orgId, ctx.settings, 6);
    if (slots.length === 0) return page("No open times this week.", "Reply to the email with a time that suits you and we will send an invite.");
    const why =
      state === "taken" ? "That time has just been taken. Here are the next open ones."
      : state === "no_calendar" ? "We could not check that time. Here are the ones open right now."
      : "That time is not available any more. Here are the next open ones.";
    return list(slots, base, why, ctx);
  }

  const slots = await slotsFor(ctx.orgId, ctx.settings, 6);
  if (slots.length === 0) {
    return page("No open times this week.", "Reply to the email with a time that suits you and we will send an invite.");
  }
  return list(slots, base, `A ${ctx.settings.durationMin}-minute call on Google Meet. ${availability(ctx)}`, ctx);
}

export async function POST(request: NextRequest) {
  const ctx = await context(request);
  if (ctx instanceof NextResponse) return ctx;
  const form = await request.formData();
  const slot = new Date(String(form.get("slot") ?? ""));
  if (Number.isNaN(slot.getTime())) return page("That time is not valid.", "Go back and pick one from the list.");

  const result = await book({
    orgId: ctx.orgId,
    productId: ctx.productId,
    personId: ctx.personId,
    settings: ctx.settings,
    start: slot,
    summary: String(ctx.access.meetingTitle ?? "TeamGrid: setup call"),
    description: String(ctx.access.meetingDescription ?? "A short call to set TeamGrid up on your machine and answer questions. Bring your team size and whatever you use for timesheets today."),
  });

  const base = `?p=${esc(ctx.personId)}&s=${esc(ctx.signature)}`;
  if (result.ok) {
    const b = result.booking;
    return page(
      `Booked: ${b.label}`,
      "The calendar invite is on its way to your inbox, with the Meet link inside.",
      b.meetLink ? `<p style="margin:16px 0 0;font-size:14px;">Meet link: <a href="${esc(b.meetLink)}" style="color:#101114;">${esc(b.meetLink)}</a></p>` : "",
    );
  }
  if (result.reason === "taken") {
    const slots = await slotsFor(ctx.orgId, ctx.settings, 6);
    return list(slots, base, "That time has just been taken. Here are the next open ones.", ctx);
  }
  return page("We could not book that just now.", "Reply to the email with a time that suits you and we will send the invite by hand.");
}

function availability(ctx: Ctx): string {
  const a = String(ctx.access.availability ?? "");
  return a ? `Times shown in ${zone(ctx.settings.timezone)}. ${a}.` : `Times shown in ${zone(ctx.settings.timezone)}.`;
}

function zone(tz: string): string {
  return tz === "Asia/Kolkata" ? "IST (Asia/Kolkata)" : tz;
}

function list(slots: Array<{ start: Date; label: string }>, base: string, detail: string, ctx: Ctx): NextResponse {
  const items = slots
    .map((s) => `<li style="margin:0 0 10px;"><a href="${base}&slot=${esc(s.start.toISOString())}" style="${LINKBTN}" data-start="${esc(s.start.toISOString())}">${esc(s.label)}</a></li>`)
    .join("");
  void ctx;
  return page("Pick a time", detail, `<ul style="list-style:none;margin:24px 0 0;padding:0;">${items}</ul>${localTime()}`);
}

/**
 * The reader's own clock, added by their browser. The lead form never asked for a time
 * zone, so the server can only speak in the calendar's; a Dubai or London reader gets the
 * same time in theirs next to it, and nothing at all if the zones match.
 */
function localTime(start?: Date): string {
  const seed = start ? `document.querySelector('input[name=slot]')?.value` : "null";
  return `<script>(function(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;if(!tz||tz==="Asia/Kolkata")return;var f=new Intl.DateTimeFormat(undefined,{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZoneName:"short"});var one=${seed};if(one){var h=document.querySelector("h1");if(h){var s=document.createElement("p");s.style.cssText="margin:8px 0 0;font-size:14px;color:#5f5e5a;";s.textContent="In your time zone: "+f.format(new Date(one));h.insertAdjacentElement("afterend",s);}}document.querySelectorAll("a[data-start]").forEach(function(a){var s=document.createElement("span");s.style.cssText="display:block;font-size:12px;font-weight:400;color:#5f5e5a;margin-top:4px;";s.textContent=f.format(new Date(a.getAttribute("data-start")));a.appendChild(s);});}catch(e){}})();</script>`;
}

const BTN = "appearance:none;border:0;border-radius:6px;background:#101114;color:#fff;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px 20px;cursor:pointer;";
const LINKBTN = "display:inline-block;border:1px solid #101114;border-radius:6px;color:#101114;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px 18px;text-decoration:none;";

/** The same one-column shell the unsubscribe page uses. A reader arriving from mail gets one thing to do. */
function page(headline: string, detail: string, extra = ""): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(headline)}</title></head>
<body style="margin:0;padding:48px 24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101114;background:#fff;">
<div style="max-width:440px;margin:0 auto;">
<h1 style="margin:0 0 8px;font-size:20px;font-weight:600;">${esc(headline)}</h1>
<p style="margin:0;color:#5f5e5a;">${esc(detail)}</p>
${extra}
</div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
