import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { verify } from "@/engine/tracking.js";
import { applyWhatsAppEvent, parseWati } from "@/engine/whatsappInbound.js";

export const dynamic = "force-dynamic";

/**
 * Where WATI reports back: a lead's reply or button tap, and what became of each message we
 * sent (delivered, read, or failed at Meta).
 *
 * WATI does not sign its webhooks, so the address is the secret: the token in the path is a
 * signature over the connection id, shown only on the channel's page, and a request without
 * the right one is refused before anything is read. It matters because a "STOP" posted here
 * unsubscribes a lead for good.
 *
 * Every accepted request is answered 200, including events we have no use for, so WATI does
 * not retry them. What was done is in the body, for anyone reading WATI's delivery log.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string; token: string }> },
) {
  const { connectionId, token } = await params;
  if (!ObjectId.isValid(connectionId) || !verify("w", connectionId, "", token)) {
    return NextResponse.json({ error: "unknown webhook" }, { status: 404 });
  }

  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection) return NextResponse.json({ error: "unknown webhook" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body was not JSON" }, { status: 400 });
  }

  const event = parseWati(body);
  if (!event) return NextResponse.json({ ok: true, done: `ignored ${String(body.eventType ?? "event")}` });

  const done = await applyWhatsAppEvent({ orgId: String(connection.orgId), productId: String(connection.productId) }, event);
  return NextResponse.json({ ok: true, done });
}
