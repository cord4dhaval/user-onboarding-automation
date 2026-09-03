import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { runSource } from "@/engine/runSource.js";
import { fireDue } from "@/engine/fireDue.js";
import { reconcileDispatched } from "@/engine/reconcile.js";
import { verifyDue } from "@/engine/verify.js";
import { recomputeTemps } from "@/engine/temp.js";
import { pollReplies } from "@/engine/inbound.js";
import { resolveChannelAdapter } from "@/engine/adapters.js";
import { closeIdleRuns, recordEngineRun } from "@/engine/runlog.js";
import { checkRoutineHealth } from "@/engine/routines.js";
import { refreshBrandSource } from "@/engine/brand.js";
import { claim, complete, fail, orgsWithWork } from "@/engine/queue.js";

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
  // Everything below shares one budget. The platform kills this request at sixty seconds,
  // so the queue drain stops well short of that and leaves the rest for the next minute.
  const started = Date.now();
  const BUDGET_MS = 45_000;

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
    // Half of temperature is decay, and nothing happens when a person goes quiet — a clock
    // is the only thing that can notice. It rides here rather than in a Claude routine
    // because it is arithmetic over signals already recorded.
    const temps = await recomputeTemps(orgId, productId, 100);
    // Replies come last because they are the only step that can end a campaign outright:
    // someone who wrote "stop" is suppressed here, and anything queued for them in this
    // same tick has already been claimed and will find them suppressed before it sends.
    const replies = await pollReplies(orgId, productId, 40);
    if (
      sent.claimed ||
      reconciled.checked ||
      verified.succeeded ||
      verified.failed ||
      temps.changed ||
      replies.recorded ||
      // A tick that found only a dead address still did something worth a row: it is the
      // reason a campaign stopped, and a run log that omits it makes that look unexplained.
      replies.bounced
    ) {
      const work = { product: String(product.name), sent, reconciled, verified, temps, replies };
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
          reheated: temps.changed ?? 0,
          replies: replies.recorded ?? 0,
          unsubscribed: replies.unsubscribed ?? 0,
        },
        report: work,
      });
    }

    await checkRoutineHealth(orgId, productId);
  }

  // Background work last, on whatever is left of the budget. Sending is time-critical and
  // an import is not, so an import must never be the reason a due message misses its tick.
  //
  // Draining by org rather than inside the product loop matters: two products under one
  // org would otherwise each open their own drain and spend the budget twice over.
  let drained = 0;
  let rowsIngested = 0;
  for (const orgId of await orgsWithWork("ingest_rows", now)) {
    while (Date.now() - started < BUDGET_MS) {
      const job = await claim<{ sourceId: string; rows: Record<string, unknown>[] }>(
        orgId,
        "ingest_rows",
      );
      if (!job) break;

      try {
        await runSource(job.payload.sourceId, job.payload.rows as never);
        await complete(job._id);
        drained++;
        rowsIngested += job.payload.rows.length;
        // Counted after the rows are committed, so the number on screen is one nobody has
        // to qualify: those people exist.
        await db
          .collection(C.sources)
          .updateOne(
            { _id: new ObjectId(job.payload.sourceId) },
            { $inc: { "progress.done": job.payload.rows.length } },
          );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await fail(job._id, message);
        report.push({ job: String(job._id), error: message });
      }
    }
  }
  if (drained) report.push({ queue: { chunks: drained, rows: rowsIngested } });

  // A routine that finished two minutes ago should not still read as running.
  const closed = await closeIdleRuns(now);

  return NextResponse.json({ at: now.toISOString(), dueSources: due.length, dueBrandSources: dueBrand.length, runsClosed: closed, report });
}
