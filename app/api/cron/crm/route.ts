import { NextResponse, type NextRequest } from "next/server";
import { crmTick } from "@/engine/crm/sync.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The CRM reader's own clock, hit by the cron job service apart from /api/cron/tick.
 *
 * Kept off the sending tick on purpose. Its speed is set by the CRM's rate limit — one call
 * every three seconds — so what it needs is a whole run to itself, and what sending needs
 * is never to wait on a slow or rate-limited CRM. Each run reads the change feed when ten
 * minutes have passed and spends the rest looking people up: about three a run.
 *
 * Hit every minute. Two runs never overlap on one connection: the second finds it locked
 * and returns. With no connection switched to CRM reading it is one empty query.
 */
const BUDGET_MS = 50_000;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = new Date();
  const report = await crmTick(started.getTime() + BUDGET_MS).catch((err) => [
    { error: err instanceof Error ? err.message : String(err) },
  ]);
  return NextResponse.json({ at: started.toISOString(), ms: Date.now() - started.getTime(), report });
}
