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
import { claim, complete, fail, orgsWithWork, reapLeases } from "@/engine/queue.js";
import { advance } from "@/engine/advance.js";
import { detectWork, watchdog } from "@/engine/detect.js";
import { dispatch } from "@/engine/dispatch.js";
import { notify } from "@/engine/notify.js";

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
  const left = () => BUDGET_MS - (Date.now() - started);
  // Every phase gets a deadline rather than a row count, because the two run out at
  // different moments and only one of them is the reason the platform kills the request.
  // A tick that is killed has still sent its mail — the send phase runs first — so from
  // outside it looks like a working system while nothing behind the send phase ever runs.
  const deadline = (share: number) => Date.now() + Math.max(1_000, Math.min(left() * share, left()));

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

  // Rotated, not walked from the top. The loop is bounded by the same wall clock as
  // everything else, so a product early in the list with a large backlog would otherwise
  // consume the budget on every single tick and the products behind it would never send at
  // all. Starting where the last tick stopped gives every product its turn.
  const cursorDoc = await db.collection(C.audit).findOne({ type: "tick_cursor" });
  const startAt = products.length ? Number(cursorDoc?.index ?? 0) % products.length : 0;
  const rotated = [...products.slice(startAt), ...products.slice(0, startAt)];
  let servedProducts = 0;

  for (const product of rotated) {
    // Sending is time-critical and the platform kills this request at sixty seconds. A
    // product that cannot be served this minute is served the next one, from the cursor.
    if (Date.now() - started > BUDGET_MS) break;
    servedProducts++;
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

    // Everything above reacts to what already exists. These four decide what happens next,
    // and all four are deterministic: turn plans into messages, notice what needs a
    // session, divide that fairly, and shout about anything that has gone quiet.
    //
    // They run here rather than inside an hourly routine because an hourly routine can only
    // see the slice it managed to read, and the slice it read was chosen by disk order.
    const advanced = await advance(orgId, productId, 100, now, deadline(0.25));
    const detected = await detectWork(orgId, productId, now, deadline(0.25));
    const late = await watchdog(orgId, productId, now);
    if (late.overdue > 0) {
      // A message that was due and never went out is not held back by any guardrail — every
      // guardrail has a state of its own. It has been forgotten, and nothing but this
      // notices.
      await notify({
        orgId,
        productId,
        dedupeKey: "actions:overdue",
        severity: "critical",
        title: `${late.overdue} message${late.overdue === 1 ? "" : "s"} overdue and unsent`,
        body: `Oldest is ${late.oldestMinutes} minutes past its send time.`,
        href: `/products/${productId}/review`,
      });
    }

    if (
      sent.claimed ||
      reconciled.checked ||
      verified.succeeded ||
      verified.failed ||
      temps.changed ||
      advanced.queued ||
      advanced.handedToClaude ||
      late.overdue ||
      replies.recorded ||
      // A tick that found only a dead address still did something worth a row: it is the
      // reason a campaign stopped, and a run log that omits it makes that look unexplained.
      replies.bounced
    ) {
      const work = { product: String(product.name), sent, reconciled, verified, temps, replies, advanced, detected, late };
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

  // A session that was killed mid-batch left rows marked running that nobody is working on.
  // Nothing else would ever look at them again, so without this the work is lost silently —
  // which is the single outcome the queue exists to prevent.
  const reaped = await reapLeases(now);
  if (reaped.requeued || reaped.dead) report.push({ leases: reaped });

  // Whose turn it is, decided every minute so the hourly routines find their work already
  // chosen and already fair. Reads counts, writes a status: it costs the same at ten
  // thousand people as at ten.
  const orgIds = [...new Set(products.map((p) => String(p.orgId)))];
  for (const orgId of orgIds) {
    if (left() <= 0) break;
    const summary = await dispatch(orgId, now);
    const busy = summary.lanes.filter((l) => l.granted || l.starved.length);
    if (busy.length) report.push({ dispatch: { orgId, lanes: busy } });

    // Starvation is only a problem if nobody can see it. The old sweep read the first two
    // hundred rows in disk order and reported "nothing to do" while thousands waited, and
    // the only symptom was silence.
    const stuck = busy.flatMap((l) => l.starved.filter((s) => s.oldestMinutes > 120));
    if (stuck.length) {
      const worst = stuck.sort((a, b) => b.oldestMinutes - a.oldestMinutes)[0]!;
      await notify({
        orgId,
        productId: worst.productId,
        dedupeKey: "dispatch:starved",
        severity: "action",
        title: `${stuck.length} campaign${stuck.length === 1 ? "" : "s"} waiting on a routine`,
        body: `"${worst.campaignKey}" has ${worst.waiting} item${worst.waiting === 1 ? "" : "s"} waiting, oldest ${Math.round(worst.oldestMinutes / 60)}h.`,
        href: `/products/${worst.productId}/goals`,
      });
    }
  }

  // Where the next tick starts its product rotation.
  if (products.length) {
    await db.collection(C.audit).updateOne(
      { type: "tick_cursor" },
      { $set: { index: (startAt + Math.max(servedProducts, 1)) % products.length, updatedAt: now } },
      { upsert: true },
    );
  }

  // A routine that finished two minutes ago should not still read as running.
  const closed = await closeIdleRuns(now);

  return NextResponse.json({
    at: now.toISOString(),
    dueSources: due.length,
    dueBrandSources: dueBrand.length,
    productsServed: servedProducts,
    productsTotal: products.length,
    runsClosed: closed,
    report,
  });
}
