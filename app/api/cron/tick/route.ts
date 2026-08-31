import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { runSource } from "@/engine/runSource.js";
import { fireDue } from "@/engine/fireDue.js";
import { reconcileDispatched } from "@/engine/reconcile.js";
import { resolveChannelAdapter } from "@/engine/adapters.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The clock. One endpoint, hit every minute; each source and goal decides for itself
 * whether it is due, so a ten-minute source costs nothing on the nine ticks in between.
 *
 * Deliberately model-free: fetching, sending and reconciling need no judgment, and a
 * model in this path would only add latency and cost.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const now = new Date();
  const report: Record<string, unknown>[] = [];

  // Only pollable kinds. An uploaded spreadsheet and a webhook push both arrive on their
  // own; putting them in the poll loop would fail on every tick, forever.
  const due = await db
    .collection(C.sources)
    .find({
      enabled: true,
      kind: { $in: ["mcp_source", "api_pull", "crm_sync"] },
      $or: [{ nextFetchAt: { $lte: now } }, { nextFetchAt: { $exists: false } }],
    })
    .limit(20)
    .toArray();

  for (const source of due) {
    try {
      const summary = await runSource(String(source._id));
      report.push({ source: String(source.name), ...summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .collection(C.sources)
        .updateOne({ _id: source._id }, { $set: { health: { status: "degraded", error: message } } });
      report.push({ source: String(source.name), error: message });
    }
  }

  // Sending and reconciliation run for every product that has anything pending, not only
  // the ones whose sources just fired.
  const products = await db.collection(C.products).find({ status: "active" }).toArray();
  for (const product of products) {
    const orgId = String(product.orgId);
    const productId = String(product._id);
    const sent = await fireDue({
      orgId,
      productId,
      dryRun: false,
      adapterFor: (channelId) => resolveChannelAdapter(orgId, channelId),
      now,
      limit: 25,
    });
    const reconciled = await reconcileDispatched(orgId, productId, 25);
    if (sent.claimed || reconciled.checked) {
      report.push({ product: String(product.name), sent, reconciled });
    }
  }

  return NextResponse.json({ at: now.toISOString(), dueSources: due.length, report });
}
