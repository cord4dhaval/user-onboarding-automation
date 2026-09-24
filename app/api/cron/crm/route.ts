import { after, NextResponse, type NextRequest } from "next/server";
import { crmTick } from "@/engine/crm/sync.js";
import { drainNotes } from "@/engine/crm/writeBack.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The CRM reader's own clock, hit by the cron job service apart from /api/cron/tick.
 *
 * Kept off the sending tick on purpose. Its speed is set by the CRM's rate limit — one call
 * every three seconds — so what it needs is a whole run to itself, and what sending needs
 * is never to wait on a slow or rate-limited CRM. Each run reads the change feed, works off
 * the records it names, and spends the rest looking up people not checked yet: three to six
 * a run.
 *
 * Hit every thirty minutes. The CRM's news reaches a person's page that much later, which
 * is fine for context nobody acts on automatically, and it keeps this well clear of a rate
 * limit the product's own mail shares. A first fill of a whole product is too big for that
 * pace and is run once with `npm run crm:sync -- --backfill`. Two runs never overlap on one
 * connection: the second finds it locked and returns. With no connection switched to CRM
 * reading it is one empty query.
 */
const BUDGET_MS = 50_000;

/**
 * Answers at once and does the work after the answer has gone.
 *
 * The cron job service gives up on a request after thirty seconds, and a run is fifty —
 * waiting for it would record every run as a failure, and a job that fails often enough is
 * switched off by the service. The work still lives within this function's sixty seconds;
 * what it did is written to the connection, where its CRM section shows it. `?wait=1`
 * runs it in the request instead, for a person testing it by hand.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = new Date();
  const deadline = started.getTime() + BUDGET_MS;
  // Reading first, writing with what is left. Their news is what a plan may be waiting on;
  // our notes are a record somebody reads later, and a note that waits half an hour costs
  // nothing. The writes share this run rather than taking their own because they share the
  // one rate limit, and two clocks against one limit is how a limit gets hit.
  const run = async () => {
    const report = await crmTick(deadline).catch((err) => [{ error: err instanceof Error ? err.message : String(err) }]);
    const notes = await drainNotes(deadline).catch((err) => ({ written: 0, failed: 0, error: err instanceof Error ? err.message : String(err) }));
    return notes.written || notes.failed || "error" in notes ? [...report, { notes }] : report;
  };

  if (request.nextUrl.searchParams.get("wait") === "1") {
    const report = await run();
    return NextResponse.json({ at: started.toISOString(), ms: Date.now() - started.getTime(), report });
  }
  after(run);
  return NextResponse.json({ at: started.toISOString(), started: true });
}
