/**
 * Local clock for development. Hits the same endpoint Vercel Cron calls in production, so
 * what runs here is exactly what runs there.
 *
 *   npm run scheduler
 */
const url = process.env.TICK_URL ?? "http://localhost:3001/api/cron/tick";
const everyMs = Number(process.env.TICK_INTERVAL_MS ?? 60_000);
const secret = process.env.CRON_SECRET;

const stamp = () => new Date().toISOString().slice(11, 19);

async function tick() {
  try {
    const res = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as { dueSources?: number; report?: unknown[] };
    const report = body.report ?? [];
    if (report.length === 0) {
      console.log(`${stamp()}  nothing due`);
    } else {
      console.log(`${stamp()}  ${body.dueSources ?? 0} source(s) due`);
      for (const entry of report) console.log(`          ${JSON.stringify(entry)}`);
    }
  } catch (err) {
    console.log(`${stamp()}  tick failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`scheduler running — ${url} every ${everyMs / 1000}s\n`);
void tick();
setInterval(tick, everyMs);

export {};
