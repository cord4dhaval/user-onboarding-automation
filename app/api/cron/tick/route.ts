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
import { identityStatus, sesConfigured } from "@/engine/sesIdentity.js";
import { refreshChannelHealth } from "@/engine/channelHealth.js";

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
  const products = shardOf(
    await db.collection(C.products).find({ status: "active" }).toArray(),
    request,
  );

  // Rotated, not walked from the top. The loop is bounded by the same wall clock as
  // everything else, so a product early in the list with a large backlog would otherwise
  // consume the budget on every single tick and the products behind it would never send at
  // all. Starting where the last tick stopped gives every product its turn.
  const cursorKey = `tick_cursor${shardSuffix(request)}`;
  const cursorDoc = await db.collection(C.audit).findOne({ type: cursorKey });
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
      { type: cursorKey },
      { $set: { index: (startAt + Math.max(servedProducts, 1)) % products.length, updatedAt: now } },
      { upsert: true },
    );
  }

  // Domains waiting on their DNS. Polled here rather than from the page because the wait is
  // hours or days: the person who pasted the records has closed the tab long before AWS
  // confirms them, and their channel still has to come up on its own.
  const domains = await pollPendingIdentities(now);
  if (domains.length) report.push({ sesIdentities: domains });

  // Every SES channel, not only the ones whose domain is still pending. Production access
  // being granted changes nothing locally — no callback, no event — so a channel held back
  // for the sandbox would stay degraded until somebody edited it by hand, hours after AWS
  // said yes. The account status behind this is cached for a minute, so re-asking per tick
  // is one call, not one per channel.
  const rechecked = await refreshSesChannels();
  if (rechecked.length) report.push({ sesChannels: rechecked });

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

/**
 * Which slice of the products this request is responsible for.
 *
 * The tick is bounded by a sixty-second platform limit that a Hobby plan cannot raise, so
 * the only way to widen the window is to run several of them at once. Four cron entries on
 * the same minute, `?shard=0&shards=4` through `?shard=3&shards=4`, give four independent
 * sixty-second budgets and no shared state to contend over.
 *
 * Split on the id rather than by position in the list, so a product stays on the same shard
 * as products are added and removed. Position would reshuffle every product on every
 * insert, and a message deferred by one shard would come back under another.
 *
 * Called with no parameters — the single-cron setup — every product is in the slice.
 */
function shardOf<T extends { _id: unknown }>(products: T[], request: NextRequest): T[] {
  const { shard, shards } = shardParams(request);
  if (shards <= 1) return products;
  return products.filter((p) => hashId(String(p._id)) % shards === shard);
}

/** Distinguishes each shard's rotation cursor. One shared cursor would have every shard
 * starting where a different shard's products left off, skipping most of its own. */
function shardSuffix(request: NextRequest): string {
  const { shard, shards } = shardParams(request);
  return shards <= 1 ? "" : `:${shard}/${shards}`;
}

function shardParams(request: NextRequest): { shard: number; shards: number } {
  const params = request.nextUrl.searchParams;
  const shards = Math.max(1, Math.min(64, Number(params.get("shards") ?? 1) || 1));
  const raw = Number(params.get("shard") ?? 0) || 0;
  // A shard number outside the range would silently serve nothing, which looks exactly
  // like a working cron that never sends.
  const shard = Math.max(0, Math.min(shards - 1, raw));
  return { shard, shards };
}

/** FNV-1a over the id. Any stable hash would do; this one needs no dependency. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Moves SES domains from pending to verified, or to failed when AWS gives up on them.
 *
 * The whole reason this is on the clock: DNS is published by whoever runs it, on their own
 * schedule, and the customer who started the setup is rarely that person and is certainly
 * not watching. A channel has to be able to come up two days after anybody last looked at
 * the page.
 *
 * Failure has to be reported as loudly as success. An identity AWS stopped checking looks
 * exactly like one still waiting, and the difference is that waiting resolves itself while
 * the other never will — the records have to go up and the domain be added again.
 */
async function pollPendingIdentities(now: Date): Promise<Array<Record<string, unknown>>> {
  if (!sesConfigured()) return [];
  const db = await getDb();
  const out: Array<Record<string, unknown>> = [];

  const pending = await db
    .collection(C.connections)
    .find({ authType: "ses", "ses.status": "pending" })
    .limit(10)
    .toArray();

  for (const connection of pending) {
    const identity = connection.ses as { domain?: string; checksUntil?: Date };
    const domain = String(identity?.domain ?? "");
    if (!domain) continue;

    try {
      const status = await identityStatus(domain);
      const expired = identity.checksUntil ? new Date(identity.checksUntil) < now : false;
      // AWS reports FAILED once it has given up, but it does not report the deadline
      // passing. Treating a still-pending identity past its own deadline as failed is what
      // stops a customer waiting on a check that stopped happening yesterday.
      const settled = status.status === "failed" || (status.status === "pending" && expired);

      if (status.status === "pending" && !expired) continue;

      await db.collection(C.connections).updateOne(
        { _id: connection._id },
        {
          $set: {
            "ses.status": settled ? "failed" : "verified",
            "ses.mailFromReady": status.mailFromReady,
            "ses.checkedAt": now,
            ...(settled ? { status: "degraded" } : { status: "healthy" }),
          },
        },
      );

      // The channel's own verdict is recomputed rather than assumed: a verified domain is
      // only half of what an SES channel needs, and the other half is a mailbox to read
      // replies in.
      const channel = await db
        .collection(C.channels)
        .findOne({ connectionId: String(connection._id) });
      if (channel) await refreshChannelHealth(String(connection.orgId), String(channel._id));

      await notify({
        orgId: String(connection.orgId),
        productId: String(connection.productId),
        severity: settled ? "action" : "good",
        dedupeKey: `ses:${settled ? "failed" : "verified"}:${domain}`,
        title: settled ? `${domain} was not verified` : `${domain} is verified`,
        body: settled
          ? status.detail ?? "AWS stopped checking for the DNS records. Add them, then add the domain again."
          : "Amazon accepted the DNS records. This domain can send as soon as a mailbox is connected for replies.",
        href: `/products/${String(connection.productId)}/channels`,
      });

      out.push({ domain, status: settled ? "failed" : "verified" });
    } catch (err) {
      out.push({ domain, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return out;
}


/**
 * Re-decides whether each SES channel can send.
 *
 * The inputs move without telling us: production access is granted by a human at AWS, a
 * mailbox can lose its read scope, Amazon can pause an account's sending. None of them
 * reach this deployment as an event, so the only way a channel comes back is by asking
 * again on a clock.
 */
async function refreshSesChannels(): Promise<Array<Record<string, unknown>>> {
  if (!sesConfigured()) return [];
  const db = await getDb();
  const out: Array<Record<string, unknown>> = [];

  const sesConnections = await db
    .collection(C.connections)
    .find({ authType: "ses" })
    .project({ _id: 1, orgId: 1 })
    .toArray();
  if (sesConnections.length === 0) return [];

  const channels = await db
    .collection(C.channels)
    .find({ connectionId: { $in: sesConnections.map((c) => String(c._id)) } })
    .limit(25)
    .toArray();

  for (const channel of channels) {
    const before = String(channel.status);
    const health = await refreshChannelHealth(String(channel.orgId), String(channel._id));
    const after = health.healthy ? "healthy" : "degraded";
    // Only a change is worth a line in the report. A tick that lists every healthy channel
    // every minute is a log nobody reads.
    if (before !== after) out.push({ channel: String(channel._id), was: before, now: after, reasons: health.reasons });
  }

  return out;
}
