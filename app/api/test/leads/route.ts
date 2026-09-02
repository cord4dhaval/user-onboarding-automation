import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * A fake lead API, so the recurring "API + token" input can be tested end to end without
 * a real CRM behind it. It is the one input kind that cannot be exercised by hand: a
 * spreadsheet arrives once and an MCP server carries live data, but a polling source only
 * proves itself when new people show up between two polls.
 *
 * The feed is a pure function of the clock, so it holds no state and cannot drift out of
 * step with the database it is feeding. Lead n becomes visible at `from + n * every`, so
 * poll it twice a few minutes apart and the second call returns strictly more than the
 * first — which is exactly the condition ingest, first-touch queuing and the tick loop
 * need to be tested against.
 *
 *   GET /api/test/leads?to=you@gmail.com&from=2026-09-01T12:00:00Z&every=120&max=20
 *
 *   to     base mailbox; every lead is plus-addressed off it, so real sends all land in
 *          one inbox and stay separable. Defaults to DEMO_EMAIL, then demo@example.com.
 *   from   anchor the drip starts from. Defaults to the top of the current hour, which
 *          makes a bare URL useful immediately and resets itself every hour.
 *   every  seconds between one lead and the next (default 120).
 *   max    how many leads the pool holds in total (default 20).
 *   seed   prefix for the addresses, so two test sources cannot collide (default "lead").
 *   window only return leads that appeared in the last N seconds. Set this a little wider
 *          than the poll interval to imitate a real incremental feed.
 *   since  ISO timestamp; returns only leads that appeared after it. Also read from
 *          `updated_since` and `cursor`, so whichever cursor parameter the source was
 *          configured with is honoured.
 *
 * Protected by TEST_FEED_TOKEN when that is set, so a deployed instance is not an open
 * lead injector. Left unset in local dev, any token is accepted.
 */

const PEOPLE = [
  { name: "Ada Okafor", role: "Head of Operations", company: "northwind.io" },
  { name: "Ben Marsh", role: "Agency Owner", company: "marshcollective.com" },
  { name: "Carla Ruiz", role: "VP Engineering", company: "lumenlabs.dev" },
  { name: "Dev Patel", role: "Founder", company: "sixtyeight.studio" },
  { name: "Eve Lindqvist", role: "Delivery Lead", company: "nordicform.se" },
  { name: "Farid Haddad", role: "COO", company: "cedarworks.co" },
  { name: "Grace Tan", role: "Head of PMO", company: "harborline.sg" },
  { name: "Hugo Bianchi", role: "Studio Director", company: "bianchi.design" },
  { name: "Ivy Chen", role: "Engineering Manager", company: "quaystack.com" },
  { name: "Jonas Weber", role: "Managing Partner", company: "weberpartner.de" },
];

const TIMEZONES = ["UTC", "Europe/London", "Asia/Kolkata", "America/New_York", "Europe/Berlin"];

export async function GET(request: NextRequest) {
  const expected = process.env.TEST_FEED_TOKEN;
  if (expected && request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams;
  const now = Date.now();

  const base = (q.get("to") ?? process.env.DEMO_EMAIL ?? "demo@example.com").trim();
  const [local, domain] = base.split("@");
  if (!local || !domain) {
    return NextResponse.json({ error: "`to` must be an email address" }, { status: 400 });
  }

  const seed = (q.get("seed") ?? "lead").replace(/[^a-z0-9]/gi, "").slice(0, 12) || "lead";
  const every = positive(q.get("every"), 120) * 1000;
  const max = Math.min(positive(q.get("max"), 20), PEOPLE.length * 10);
  const anchor = parseDate(q.get("from"))?.getTime() ?? new Date(now).setMinutes(0, 0, 0);

  // Only what the clock has released so far. A lead that has not been "created" yet is
  // simply absent, the same way a CRM row that does not exist yet is absent.
  const released = anchor > now ? 0 : Math.min(Math.floor((now - anchor) / every) + 1, max);

  const windowSec = Number(q.get("window") ?? 0);
  const since = parseDate(q.get("since") ?? q.get("updated_since") ?? q.get("cursor"));
  const floor = Math.max(
    since ? since.getTime() : 0,
    windowSec > 0 ? now - windowSec * 1000 : 0,
  );

  const data = [];
  for (let n = 0; n < released; n++) {
    const createdAt = anchor + n * every;
    if (createdAt <= floor) continue;
    const person = PEOPLE[n % PEOPLE.length]!;
    // The index is part of the address, so the eleventh lead is a new person rather than
    // a second arrival of the first one.
    const suffix = n < PEOPLE.length ? "" : `.${Math.floor(n / PEOPLE.length) + 1}`;
    data.push({
      id: `${seed}-${String(n + 1).padStart(3, "0")}`,
      email: `${local}+${seed}${String(n + 1).padStart(3, "0")}@${domain}`,
      name: `${person.name}${suffix}`,
      role: person.role,
      company_domain: person.company,
      timezone: TIMEZONES[n % TIMEZONES.length]!,
      created_at: new Date(createdAt).toISOString(),
    });
  }

  return NextResponse.json(
    {
      data,
      // The adapter reads this and the source stores it, so a cursor-configured source
      // resumes from the last lead it actually saw rather than the wall clock.
      nextCursor: released > 0 ? new Date(anchor + (released - 1) * every).toISOString() : undefined,
      released,
      total: max,
      nextLeadAt: released < max ? new Date(anchor + released * every).toISOString() : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function positive(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
