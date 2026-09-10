import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { verify } from "@/engine/tracking.js";
import { recordSiteEvent } from "@/engine/siteEvents.js";

export const dynamic = "force-dynamic";

/**
 * Where a customer's own website reports that somebody reached a page.
 *
 * The other half of a campaign whose finish line is not in anybody's CRM. "They booked a
 * call" is not a question a tool can be asked when the booking happens on a page you own
 * and nothing else knows about it — so the page says so, here, and a check of kind `page`
 * reads it.
 *
 * Unauthenticated by necessity, exactly like the tracking endpoint: the caller is a
 * browser on someone else's domain. What stands in for a session is the signature, which
 * covers the person. Without it this would be an endpoint that finishes a stranger's
 * campaign for the price of guessing an id, and ObjectIds are far too guessable for that.
 *
 * A repeat inside a minute is dropped. A thank-you page that a person refreshes four times
 * is one booking, and four events would read as a queue of them.
 */
async function record(request: NextRequest, event: string): Promise<NextResponse> {
  const personId = request.nextUrl.searchParams.get("p") ?? "";
  const signature = request.nextUrl.searchParams.get("s") ?? "";
  if (!ObjectId.isValid(personId)) return new NextResponse(null, { status: 404, headers: cors() });
  if (!verify("e", personId, "", signature)) return new NextResponse(null, { status: 404, headers: cors() });
  const ok = await recordSiteEvent(personId, event, request.headers.get("referer"));
  return new NextResponse(null, { status: ok ? 204 : 404, headers: cors() });
}

/** Called from a page on the customer's own domain, so the browser asks first. */
function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Cache-Control": "no-store",
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ event: string }> }) {
  return record(request, (await params).event);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ event: string }> }) {
  return record(request, (await params).event);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}
