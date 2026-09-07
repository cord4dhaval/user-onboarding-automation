import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { verify } from "@/engine/tracking.js";
import { verifyCampaign } from "@/engine/verify.js";

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
const REPEAT_WINDOW_MS = 60_000;

async function record(request: NextRequest, event: string): Promise<NextResponse> {
  const name = event.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  if (!name) return new NextResponse(null, { status: 404, headers: cors() });

  const personId = request.nextUrl.searchParams.get("p") ?? "";
  const signature = request.nextUrl.searchParams.get("s") ?? "";
  if (!ObjectId.isValid(personId)) return new NextResponse(null, { status: 404, headers: cors() });
  if (!verify("e", personId, "", signature)) return new NextResponse(null, { status: 404, headers: cors() });

  const db = await getDb();
  const person = await db
    .collection(C.people)
    .findOne({ _id: new ObjectId(personId) }, { projection: { orgId: 1, productId: 1 } });
  // A valid signature for a person who has since been deleted. Nothing to record against.
  if (!person) return new NextResponse(null, { status: 404, headers: cors() });

  const orgId = String(person.orgId);
  const productId = String(person.productId);
  const type = `site_event:${name}`;
  const now = new Date();

  const recent = await db
    .collection(C.events)
    .findOne({ orgId, personId, type, ts: { $gte: new Date(now.getTime() - REPEAT_WINDOW_MS) } });

  if (!recent) {
    await db.collection(C.events).insertOne({
      _id: new ObjectId(),
      orgId,
      productId,
      personId,
      source: "product",
      type,
      payload: { event: name, referer: request.headers.get("referer") ?? null },
      ts: now,
    });

    // Checked immediately rather than on the next tick. The whole point of this endpoint is
    // that somebody just did the thing the campaign was driving at, and a person who books
    // a call and then receives the next chase an hour later has been told nobody noticed.
    const active = await db
      .collection(C.goalInstances)
      .find({ orgId, productId, personId, status: "active" })
      .project({ _id: 1 })
      .toArray();
    for (const instance of active) {
      try {
        await verifyCampaign(orgId, String(instance._id));
      } catch {
        // A verifier that cannot answer must never turn a recorded fact into a 500. The
        // event is written; the next tick will read it.
      }
    }
  }

  return new NextResponse(null, { status: 204, headers: cors() });
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
