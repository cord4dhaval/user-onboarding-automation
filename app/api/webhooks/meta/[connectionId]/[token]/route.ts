import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { verify } from "@/engine/tracking.js";
import { applyWhatsAppEvent, parseMeta } from "@/engine/whatsappInbound.js";

export const dynamic = "force-dynamic";

/**
 * The connection this address belongs to, or null for an address that was not issued here.
 *
 * The token in the path is a signature over the connection id, shown only on the channel's
 * page. Meta does sign its calls, with the app secret over the raw body, but the secret is
 * an app-wide value we would have to store beside every tenant's connection to check it —
 * whereas the signed path is already per connection and already how the WATI route works.
 */
async function connectionFor(connectionId: string, token: string) {
  if (!ObjectId.isValid(connectionId) || !verify("w", connectionId, "", token)) return null;
  const db = await getDb();
  return db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
}

/**
 * Meta's subscription check, called once when the address is saved in the app dashboard.
 *
 * It keeps the address only if the challenge comes back on its own, as text. A JSON body,
 * or the number quoted, and the field silently stays empty — which is how a webhook ends up
 * looking configured while nothing is ever delivered to it.
 *
 * hub.verify_token is not read. The path is already the secret, and a caller who knows it
 * has proved more than a word pasted into two screens would.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ connectionId: string; token: string }> }) {
  const { connectionId, token } = await params;
  if (!(await connectionFor(connectionId, token))) return NextResponse.json({ error: "unknown webhook" }, { status: 404 });

  const challenge = request.nextUrl.searchParams.get("hub.challenge");
  if (!challenge) return NextResponse.json({ error: "no challenge" }, { status: 400 });
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Where Meta reports back: a lead's reply or button tap, and what became of each message we
 * sent. One call carries several events, so every one is applied and the body says what each
 * did, for anyone reading Meta's own delivery log.
 *
 * Every accepted request is answered 200, including events we have no use for, because Meta
 * retries anything else and a retried "delivered" is noise. It matters that this address is
 * right: a "STOP" posted here unsubscribes a lead for good.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ connectionId: string; token: string }> }) {
  const { connectionId, token } = await params;
  const connection = await connectionFor(connectionId, token);
  if (!connection) return NextResponse.json({ error: "unknown webhook" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body was not JSON" }, { status: 400 });
  }

  const events = parseMeta(body);
  if (events.length === 0) return NextResponse.json({ ok: true, done: ["nothing we use"] });

  const where = { orgId: String(connection.orgId), productId: String(connection.productId), connectionId };
  const done: string[] = [];
  for (const event of events) done.push(await applyWhatsAppEvent(where, event));
  return NextResponse.json({ ok: true, done });
}
