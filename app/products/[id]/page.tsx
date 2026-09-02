import type { ReactNode } from "react";
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  Inbox,
  Info,
  RefreshCw,
  Send,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { refreshDashboard } from "../../actions";
import { getProduct, requireSession, scope } from "../../tenant";
import ClaudeBadge from "../../ui/claude-badge";
import Popover from "../../ui/popover";
import Tooltip from "../../ui/tooltip";
import { ActionButton } from "../../ui/kit";
import { BarChart, Funnel, Sparkline } from "../../ui/charts";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 14;

/** Anything a person can actually do something about. Nothing else earns a place here. */
interface Alert {
  text: string;
  href: string;
  action: string;
  tone: "warn" | "bad";
  why: string;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** A dense day axis: every day in the window is present, including the empty ones. */
function emptyDays(from: Date, days: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    out.set(dayKey(new Date(from.getTime() + i * 86_400_000)), 0);
  }
  return out;
}

function tally(dates: Array<Date | undefined | null>, from: Date, days: number): number[] {
  const buckets = emptyDays(from, days);
  for (const d of dates) {
    if (!d) continue;
    const key = dayKey(new Date(d));
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.values()];
}

const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export default async function ProductHome({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const product = await getProduct(id, orgId);
  if (!product) return null;

  const db = await getDb();
  const s = scope(orgId, id);
  const base = `/products/${id}`;

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowStart = new Date(startOfToday.getTime() - (WINDOW_DAYS - 1) * 86_400_000);
  const priorStart = new Date(windowStart.getTime() - WINDOW_DAYS * 86_400_000);

  const [people, instances, actions, channels, goals, sources, templates] = await Promise.all([
    db
      .collection(C.people)
      .find(s, {
        projection: {
          name: 1, primaryEmail: 1, lifecycle: 1, temp: 1,
          createdAt: 1, lastContactedAt: 1, needsClassification: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray(),
    db.collection(C.goalInstances).find(s).sort({ startedAt: -1 }).limit(300).toArray(),
    db
      .collection(C.actions)
      .find(s, { projection: { status: 1, sentAt: 1, personId: 1, goalInstanceId: 1, channel: 1 } })
      .sort({ dueAt: -1 })
      .limit(1000)
      .toArray(),
    db.collection(C.channels).find(s).toArray(),
    db.collection(C.goals).find(s).toArray(),
    db.collection(C.sources).find(s).toArray(),
    db.collection(C.templates).countDocuments(s),
  ]);

  const byStatus = (status: string) => actions.filter((a) => String(a.status) === status);
  const held = byStatus("awaiting_approval");
  const failed = byStatus("failed");
  const queued = byStatus("queued");
  const sent = byStatus("sent");

  const inWindow = (d: unknown) => d instanceof Date && d >= windowStart;
  const inPrior = (d: unknown) => d instanceof Date && d >= priorStart && d < windowStart;

  const sentDates = sent.map((a) => a.sentAt as Date | undefined);
  const personDates = people.map((p) => p.createdAt as Date | undefined);
  const startedDates = instances.map((i) => i.startedAt as Date | undefined);
  const wonDates = instances
    .filter((i) => String(i.status) === "succeeded")
    .map((i) => (i.endedAt ?? i.startedAt) as Date | undefined);

  const series = {
    sent: tally(sentDates, windowStart, WINDOW_DAYS),
    people: tally(personDates, windowStart, WINDOW_DAYS),
    started: tally(startedDates, windowStart, WINDOW_DAYS),
    won: tally(wonDates, windowStart, WINDOW_DAYS),
  };

  /** This window against the one before it — a number with no baseline says nothing. */
  const delta = (dates: Array<Date | undefined>) => ({
    current: dates.filter(inWindow).length,
    prior: dates.filter(inPrior).length,
  });

  const sentBars = [...emptyDays(windowStart, WINDOW_DAYS).keys()].map((iso, i) => ({
    label: shortDay(iso),
    value: series.sent[i] ?? 0,
  }));

  // ── the funnel ──────────────────────────────────────────────────────────────
  const contacted = people.filter((p) => p.lastContactedAt).length;
  const inCampaign = new Set(instances.map((i) => String(i.personId))).size;
  const won = instances.filter((i) => String(i.status) === "succeeded").length;

  // ── alerts ──────────────────────────────────────────────────────────────────
  const alerts: Alert[] = [];
  if (held.length > 0) {
    alerts.push({
      text: `${held.length} message${held.length === 1 ? "" : "s"} waiting for you to review`,
      href: `${base}/review`,
      action: "Review",
      tone: "warn",
      why: "These campaigns hold each message for approval. Nothing leaves until you say so, and the rest of the sequence waits behind them.",
    });
  }
  for (const channel of channels.filter((c) => c.status !== "healthy")) {
    alerts.push({
      text: `The ${String(channel.key)} channel is ${String(channel.status)}`,
      href: `${base}/channels`,
      action: "Fix",
      tone: "bad",
      why: "A channel that cannot send turns every queued message into a backlog. The engine keeps queueing; nothing goes out.",
    });
  }
  for (const source of sources.filter((src) => (src.health as { status?: string } | undefined)?.status === "degraded")) {
    alerts.push({
      text: `Input "${String(source.name)}" is failing`,
      href: `${base}/goals`,
      action: "Open",
      tone: "bad",
      why: "The last few fetches errored, so new people are not arriving. Campaigns keep running on whoever is already here.",
    });
  }
  if (failed.length > 0) {
    alerts.push({
      text: `${failed.length} message${failed.length === 1 ? "" : "s"} failed to send`,
      href: `${base}/library`,
      action: "Inspect",
      tone: "bad",
      why: "The provider rejected these. Until the cause is fixed the same address keeps failing on every retry.",
    });
  }
  const unverifiable = goals.filter(
    (g) => g.enabled !== false && ((g.checks ?? []) as unknown[]).length === 0,
  ).length;
  if (unverifiable > 0) {
    alerts.push({
      text: `${unverifiable} campaign${unverifiable === 1 ? "" : "s"} cannot tell when anyone succeeds`,
      href: `${base}/goals`,
      action: "See why",
      tone: "warn",
      why: "You picked where to verify; working out which of that server's tools answer the success sentence is Claude's part. The Plan routine writes it on its next run.",
    });
  }

  // Setup is a chain: each step is pointless until the one above it is done.
  const setup = [
    { done: channels.length > 0, label: "Connect a channel", href: `${base}/channels` },
    { done: templates > 0, label: "Generate templates", href: `${base}/templates` },
    { done: goals.length > 0, label: "Create a campaign", href: `${base}/goals` },
    { done: sources.length > 0, label: "Give that campaign an input", href: `${base}/goals` },
  ];
  const incomplete = setup.filter((x) => !x.done);

  const cfg = product.config as {
    oneLiner?: string;
    activation?: { describedAs?: string };
    segments?: Array<{ key: string; name: string; pain: string }>;
  };
  const unclassified = people.filter((p) => p.needsClassification === true).length;

  return (
    <>
      <div className="head">
        <div>
          <h1>{String(product.name)}</h1>
          <p className="sub" style={{ marginBottom: 0 }}>{cfg.oneLiner}</p>
        </div>
        <div className="spacer" />
        <ActionButton
          variant="quiet"
          icon={<RefreshCw />}
          action={refreshDashboard.bind(null, id)}
          pendingLabel="Refreshing…"
          toast={{ title: "Dashboard refreshed", body: "Alerts recalculated from current state." }}
        >
          Refresh
        </ActionButton>
      </div>

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a) => (
            <div className={`alert-row ${a.tone}`} key={a.text}>
              {a.tone === "bad" ? <CircleDashed size={16} /> : <Inbox size={16} />}
              <span>{a.text}</span>
              <Popover trigger={<Info size={14} />} title="Why this matters">
                {a.why}
              </Popover>
              <span className="spacer" />
              <a className="btn ghost sm" href={a.href}>{a.action} <ArrowRight size={13} /></a>
            </div>
          ))}
        </div>
      )}

      {incomplete.length > 0 && (
        <div className="note">
          <p style={{ marginBottom: 8 }}><strong>Finish setting up</strong></p>
          <div className="checks">
            {setup.map((x) => (
              <span className="status" key={x.label} style={{ fontSize: 13.5 }}>
                {x.done ? <CircleCheck size={15} color="var(--good)" /> : <CircleDashed size={15} color="var(--warm)" />}
                {x.done ? <s className="muted">{x.label}</s> : <a href={x.href}>{x.label}</a>}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="tiles">
        <Tile
          icon={<Users size={14} />}
          label="People"
          explain="Everyone this product has ever touched, including anyone who has since said no."
          value={people.length}
          spark={series.people}
          {...delta(personDates)}
        />
        <Tile
          icon={<Target size={14} />}
          label="In flight"
          explain="People a campaign is actively working on right now."
          value={instances.filter((i) => String(i.status) === "active").length}
          spark={series.started}
          {...delta(startedDates)}
        />
        <Tile
          icon={<Send size={14} />}
          label={`Sent · ${WINDOW_DAYS}d`}
          explain="Messages the provider accepted in this window. Queued and held messages are not counted."
          value={sentDates.filter(inWindow).length}
          spark={series.sent}
          {...delta(sentDates)}
        />
        <Tile
          icon={<CircleCheck size={14} />}
          label="Succeeded"
          explain="Campaign runs whose success checks came back true against the connected source."
          value={won}
          spark={series.won}
          {...delta(wonDates)}
        />
      </div>

      <div className="panels">
        <section className="panel">
          <header>
            <h3>Messages sent</h3>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12.5 }}>last {WINDOW_DAYS} days</span>
          </header>
          <BarChart data={sentBars} emptyNote="No messages have gone out in this window." />
        </section>

        <section className="panel">
          <header>
            <h3>Conversion path</h3>
            <span className="spacer" />
            <Tooltip
              side="bottom"
              label="Each step is a subset of the one above it, so the drop between two bars is where people are actually being lost."
            >
              <Info size={14} className="muted" />
            </Tooltip>
          </header>
          <Funnel
            stages={[
              { label: "In the library", value: people.length },
              { label: "In a campaign", value: inCampaign },
              { label: "Contacted", value: contacted, hint: "at least one message" },
              { label: "Succeeded", value: won, hint: "verified" },
            ]}
          />
        </section>
      </div>

      {queued.length > 0 && (
        <p className="sub row" style={{ gap: 6 }}>
          <Send size={13} /> {queued.length} message{queued.length === 1 ? "" : "s"} queued, waiting for a send
          window.
        </p>
      )}

      <h2>Activation</h2>
      <p>{cfg.activation?.describedAs ?? "Not defined yet."}</p>
      <p className="sub">
        Every campaign aims at this, not at signup. An activated trial converts several times better than an
        inactive one, so this line matters more than any other in the config.
      </p>

      <h2>Segments</h2>
      {!cfg.segments?.length ? (
        <div className="empty">
          <strong>No segments yet</strong>
          They drive which template variant each person gets. Add them in <a href={`${base}/settings`}>settings</a>.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead><tr><th>Segment</th><th>What they are stuck on</th></tr></thead>
            <tbody>
              {cfg.segments.map((seg) => (
                <tr key={seg.key}>
                  <td>
                    <strong>{seg.name}</strong>
                    <div className="muted" style={{ fontSize: 12.5 }}><code>{seg.key}</code></div>
                  </td>
                  <td className="muted">{seg.pain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unclassified > 0 && (
        <p className="sub row" style={{ gap: 6 }}>
          <ClaudeBadge note={`${unclassified} waiting`} />
          They get a segment and a plan on the next routine run — see <a href={`${base}/claude`}>Claude</a>.
        </p>
      )}
    </>
  );
}

/**
 * A number, its recent shape, and how it compares with the window before it. The sparkline
 * is texture rather than a plot — it answers "is this rising" without asking anyone to read
 * an axis, and the delta beside it says the same thing in words.
 */
function Tile({
  icon,
  label,
  explain,
  value,
  spark,
  current,
  prior,
}: {
  icon: ReactNode;
  label: string;
  explain: string;
  value: number;
  spark: number[];
  current: number;
  prior: number;
}) {
  const change = current - prior;
  const tone = change > 0 ? "up" : change < 0 ? "down" : "flat";

  return (
    <div className="tile">
      <div className="tile-top">
        <Tooltip label={explain} side="bottom">
          <span className="label">{label}</span>
          <Info size={12} />
        </Tooltip>
        <span style={{ marginLeft: "auto" }} />
        {icon}
      </div>
      <div className="tile-value">{value}</div>
      <div className="tile-foot">
        <span className={`tile-delta ${tone}`}>
          {change > 0 ? <TrendingUp size={12} /> : change < 0 ? <TrendingDown size={12} /> : null}
          {change === 0 ? "no change" : `${change > 0 ? "+" : ""}${change}`}
        </span>
        <Sparkline data={spark} />
      </div>
    </div>
  );
}
