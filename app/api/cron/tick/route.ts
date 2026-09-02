import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { runSource } from "@/engine/runSource.js";
import { fireDue } from "@/engine/fireDue.js";
import { reconcileDispatched } from "@/engine/reconcile.js";
import { verifyDue } from "@/engine/verify.js";
import { resolveChannelAdapter } from "@/engine/adapters.js";
import { closeIdleRuns, recordEngineRun } from "@/engine/runlog.js";
import { checkRoutineHealth } from "@/engine/routines.js";
import { refreshBrandSource } from "@/engine/brand.js";

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
      kind: { $in: ["mcp_source", "api_pull", "crm_sync", "audience"] },
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

  // Brand refresh rides the same clock but on its own interval — a palette changes a few
  // times a year, so a due check that almost always finds nothing costs almost nothing.
  const dueBrand = await db
    .collection(C.brandSources)
    .find({
      enabled: true,
      $or: [{ nextFetchAt: { $lte: now } }, { nextFetchAt: { $exists: false } }],
    })
    .limit(5)
    .toArray();

  for (const source of dueBrand) {
    try {
      await refreshBrandSource(String(source._id));
    } catch (err) {
      // A brand provider being down means today's mail looks plainer. It is never a
      // reason to fail the tick that also sends it.
      report.push({ brandSource: String(source.name), error: err instanceof Error ? err.message : String(err) });
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
    // Verification runs on the same clock as sending: a campaign that has succeeded should
    // stop chasing someone within a minute, not on the next hourly Claude pass.
    const verified = await verifyDue(orgId, productId, 25);
    if (sent.claimed || reconciled.checked || verified.succeeded || verified.failed) {
      const work = { product: String(product.name), sent, reconciled, verified };
      report.push(work);
      // Only ticks that did something are kept. A row a minute, mostly empty, would bury
      // the ones worth reading under 1,400 that say nothing.
      await recordEngineRun({
        orgId,
        productId,
        startedAt: now,
        counters: {
          // A claimed message is not a sent one — three held for review would otherwise
          // read as three delivered.
          sent: sent.sent ?? 0,
          held: sent.heldForApproval ?? 0,
          deferred: sent.deferred ?? 0,
          reconciled: reconciled.checked ?? 0,
          succeeded: verified.succeeded ?? 0,
          failed: verified.failed ?? 0,
        },
        report: work,
      });
    }

    await checkRoutineHealth(orgId, productId);
  }

  // A routine that finished two minutes ago should not still read as running.
  const closed = await closeIdleRuns(now);

  return NextResponse.json({ at: now.toISOString(), dueSources: due.length, dueBrandSources: dueBrand.length, runsClosed: closed, report });
}
