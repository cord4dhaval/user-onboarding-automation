import { NextResponse, type NextRequest } from "next/server";
import { listNotifications, markAllRead, markRead, refreshDerived } from "@/engine/notify.js";
import { currentSession } from "../../tenant";

export const dynamic = "force-dynamic";

/**
 * Polled by the bell rather than streamed. A long-lived connection does not survive a
 * serverless function's lifetime, and a short poll is honest about that — it also keeps
 * working when the tab has been asleep, which a dropped stream does not.
 */
export async function GET(request: NextRequest) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const productId = request.nextUrl.searchParams.get("product");
  if (!productId) return NextResponse.json({ error: "product required" }, { status: 400 });

  // Conditions nothing explicitly reported — a channel that went degraded between runs —
  // are recomputed here, so the bell reflects reality rather than only past events.
  await refreshDerived(session.orgId, productId);
  const items = await listNotifications(session.orgId, productId);

  return NextResponse.json(
    { items, unread: items.length },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { ids?: string[]; product?: string; all?: boolean };

  if (body.all && body.product) {
    return NextResponse.json({ marked: await markAllRead(session.orgId, body.product) });
  }
  if (body.ids?.length) {
    return NextResponse.json({ marked: await markRead(session.orgId, body.ids) });
  }
  return NextResponse.json({ marked: 0 });
}
