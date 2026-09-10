import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { verify } from "@/engine/tracking.js";
import { book, calendarSettingsFrom, labelFor, slotsFor, type CalendarSettings } from "@/engine/booking.js";

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
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) }, { projection: { orgId: 1, productId: 1, suppressedAt: 1 } });
  if (!person || person.suppressedAt) return page("This link is not valid.", "Reply to the email you received and we will send a fresh one.");
  const orgId = String(person.orgId);
  const productId = String(person.productId);

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

  const slots = await slotsFor(ctx.orgId, ctx.settings, 6);
  if (slots.length === 0) {
    return page("No open times this week.", "Reply to the email with a time that suits you and we will send an invite.");
  }

  const chosen = slotParam ? slots.find((s) => s.start.toISOString() === new Date(slotParam).toISOString()) : undefined;
  if (slotParam && !chosen) {
    return list(slots, base, "That time has just been taken. Here are the next open ones.", ctx);
  }
  if (chosen) {
    return page(
      `Book ${chosen.label}?`,
      `A ${ctx.settings.durationMin}-minute call on Google Meet. The invite goes to the address we wrote to. ${availability(ctx)}`,
      `<form method="post" action="${base}" style="margin:24px 0 0;">
<input type="hidden" name="slot" value="${esc(chosen.start.toISOString())}" />
<button type="submit" style="${BTN}">Book this time</button>
<p style="margin:16px 0 0;font-size:14px;"><a href="${base}" style="color:#101114;">Pick a different time</a></p>
</form>`,
    );
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
    .map((s) => `<li style="margin:0 0 10px;"><a href="${base}&slot=${esc(s.start.toISOString())}" style="${LINKBTN}">${esc(s.label)}</a></li>`)
    .join("");
  void ctx;
  void labelFor;
  return page("Pick a time", detail, `<ul style="list-style:none;margin:24px 0 0;padding:0;">${items}</ul>`);
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
