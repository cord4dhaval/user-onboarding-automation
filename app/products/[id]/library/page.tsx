import { Bot, Filter, Layers, MessageSquare, MousePointerClick, Mail, Search, Users } from "lucide-react";
import { audienceCount, queryLibrary, type DeliveryState } from "@/engine/library.js";
import { peopleEngagement, peopleMatching, type EngagementState } from "@/engine/engagement.js";
import { replyReach } from "@/engine/reach.js";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { deleteAudience, importPeople, saveAudience } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ClaudeBadge from "../../../ui/claude-badge";
import ConfirmButton from "../../../ui/confirm";
import { SubmitButton, Tabs } from "../../../ui/kit";
import AudienceDrawer from "../audiences/audience-drawer";
import ImportDrawer from "./import-drawer";
import { istDay, ist } from "../../../ui/time";

export const dynamic = "force-dynamic";

const STATES = ["new", "active", "cooling", "dormant", "suppressed"] as const;

const DELIVERY: Array<{ key: DeliveryState; label: string }> = [
  { key: "sent", label: "sent — handed to the provider" },
  { key: "delivered", label: "delivered — provider confirmed" },
  { key: "failed", label: "failed" },
  { key: "pending", label: "not sent yet" },
];

/**
 * What we sent is only half the page. Until now the other half — what they did about it —
 * was a single date column, so "who clicked" was a question the library could not answer
 * even though every click was recorded.
 */
const ENGAGEMENT: Array<{ key: EngagementState; label: string }> = [
  { key: "clicked", label: "clicked a link" },
  { key: "replied", label: "replied" },
  { key: "opened", label: "opened (unreliable)" },
  { key: "none", label: "never responded" },
];

const LIFECYCLE_COPY: Record<string, string> = {
  new: "never contacted",
  active: "a campaign is working on them",
  cooling: "an attempt ended, resting",
  dormant: "several attempts spent",
  suppressed: "said no — permanent",
};

/** Reads a saved filter back as the sentence it stands for. */
function describe(filter: Record<string, unknown> | undefined): string {
  if (!filter) return "everyone";
  const parts: string[] = [];
  if (filter.silentDays) parts.push(`not messaged for ${String(filter.silentDays)}d`);
  if (filter.quietDays) parts.push(`quiet for ${String(filter.quietDays)}d`);
  if ((filter.lifecycle as string[])?.length) parts.push((filter.lifecycle as string[]).join(" or "));
  if ((filter.temperature as string[])?.length) parts.push((filter.temperature as string[]).join(" or "));
  if (filter.everEngaged) parts.push("has engaged before");
  if (filter.minIcpFit) parts.push(`fit ≥ ${String(filter.minIcpFit)}`);
  return parts.length ? parts.join(" · ") : "everyone, minus anyone who said no";
}

/**
 * People and the groups built from them are one subject, so they are one page. They were
 * split only because each list was long, which is a scrolling problem and not a
 * navigation one.
 */
export default async function Audience({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    q?: string;
    state?: string;
    campaign?: string;
    delivery?: string;
    engagement?: string;
    tab?: string;
  }>;
}) {
  const { id } = await params;
  const { q, state, campaign, delivery, engagement, tab } = await searchParams;
  const deliveryKey = DELIVERY.find((d) => d.key === delivery)?.key;
  const engagementKey = ENGAGEMENT.find((e) => e.key === engagement)?.key;
  const current = tab === "audiences" ? "audiences" : "people";
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);
  const base = `/products/${id}/library`;

  const [{ rows, total }, everyone, audienceDocs, goals] = await Promise.all([
    queryLibrary(orgId, id, {
      search: q,
      lifecycle: state ? [state] : undefined,
      campaign: campaign || undefined,
      delivery: deliveryKey,
      engagement: engagementKey,
      limit: 100,
    }),
    db.collection(C.people).countDocuments(s),
    db.collection(C.audiences).find(s).sort({ createdAt: -1 }).toArray(),
    db.collection(C.goals).find(s).project({ key: 1, name: 1 }).toArray(),
  ]);

  const counts = Object.fromEntries(
    await Promise.all(
      STATES.map(async (st) => [st, await db.collection(C.people).countDocuments({ ...s, lifecycle: st })] as const),
    ),
  );
  const sized = await Promise.all(
    audienceDocs.map(async (a) => ({ audience: a, size: await audienceCount(orgId, id, a) })),
  );

  // The headline the page was missing. These are people, not messages: someone who clicked
  // three links is one interested human, and three would read as three leads.
  const [clickedIds, repliedIds, openedIds, reach, pixelled, scanned] = await Promise.all([
    peopleMatching(orgId, id, "clicked"),
    peopleMatching(orgId, id, "replied"),
    peopleMatching(orgId, id, "opened"),
    replyReach(orgId, id),
    // Whether a pixel ever went out. Without one, "0 opened" is not a measurement.
    db.collection(C.actions).countDocuments({ ...s, status: "sent", "tracking.opens": true }),
    db.collection(C.actions).countDocuments({ ...s, firstMachineClickedAt: { $exists: true } }),
  ]);
  const engaged = await peopleEngagement(orgId, id, rows.map((r) => String(r._id)));

  // Each tile states what it knows, or says plainly that it cannot know. A tile reading
  // zero when nothing was ever measured is the single most misleading thing this page
  // could show — it invites a rewrite of copy that was never the problem.
  const signals = [
    {
      key: "clicked" as const,
      icon: <MousePointerClick size={14} />,
      label: "clicked a link",
      value: String(clickedIds.length),
      measured: true,
      note:
        scanned > 0
          ? `The strongest signal that arrives without words. ${scanned} scanner fetch${scanned === 1 ? "" : "es"} excluded.`
          : "The strongest signal that arrives without words.",
    },
    {
      key: "replied" as const,
      icon: <MessageSquare size={14} />,
      label: "replied",
      value: reach.replies ? String(repliedIds.length) : "—",
      measured: reach.replies,
      note: reach.replies
        ? "Someone typed at us. Nothing outranks it."
        : `Not being read: ${reach.why}. Connect a mailbox on Channels.`,
    },
    {
      key: "opened" as const,
      icon: <Mail size={14} />,
      label: "opened",
      value: pixelled > 0 ? String(openedIds.length) : "—",
      measured: pixelled > 0,
      note:
        pixelled > 0
          ? "Counted, not trusted — some clients load images on their own."
          : "Never measured. A pixel needs opt-in consent; these leads arrived under legitimate interest.",
    },
  ];

  return (
    <>
      <div className="head">
        <div>
          <h1>Audience</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Everyone this product has ever touched, and the groups built from them. Nobody is ever deleted —
            someone who says no is suppressed, so they can never be picked up again by accident.
          </p>
        </div>
        <div className="spacer" />
        {current === "people" ? (
          <ImportDrawer productId={id} action={importPeople} />
        ) : (
          <AudienceDrawer productId={id} action={saveAudience} />
        )}
      </div>

      <Tabs
        current={current}
        tabs={[
          { key: "people", label: "People", href: base, icon: <Users />, count: everyone },
          {
            key: "audiences",
            label: "Groups",
            href: `${base}?tab=audiences`,
            icon: <Layers />,
            count: sized.length,
          },
        ]}
      />

      {current === "people" ? (
        <>
          {/* One row that answers "did any of this land?" without reading a table. Each
              tile is a link, because a number nobody can drill into is a poster. */}
          <div className="signal-strip">
            {signals.map((sig) => {
              const body = (
                <>
                  <span className="signal-top">{sig.icon}<span className="label">{sig.label}</span></span>
                  <span className="signal-value">{sig.value}</span>
                  <span className="signal-note">{sig.note}</span>
                </>
              );
              // Nothing to filter by when nothing was measured, so it is not a link.
              return sig.measured ? (
                <a
                  key={sig.key}
                  className={`signal ${engagementKey === sig.key ? "on" : ""} ${Number(sig.value) > 0 ? "live" : ""}`}
                  href={`${base}?engagement=${sig.key}${campaign ? `&campaign=${campaign}` : ""}`}
                >
                  {body}
                </a>
              ) : (
                <div key={sig.key} className="signal unmeasured">{body}</div>
              );
            })}
          </div>

          <form method="get" className="row" style={{ marginBottom: 18 }}>
            <div style={{ position: "relative", flex: "0 1 320px" }}>
              <Search
                size={15}
                style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", opacity: .5 }}
              />
              <input
                name="q"
                defaultValue={q ?? ""}
                placeholder="Search name, email or company"
                style={{ paddingLeft: 33 }}
              />
            </div>
            <select name="state" defaultValue={state ?? ""} style={{ maxWidth: 200 }}>
              <option value="">Everyone ({everyone})</option>
              {STATES.map((st) => (
                <option key={st} value={st}>{st} ({counts[st] ?? 0})</option>
              ))}
            </select>
            <select name="campaign" defaultValue={campaign ?? ""} style={{ maxWidth: 220 }}>
              <option value="">Any campaign</option>
              {goals.map((g) => (
                <option key={String(g.key)} value={String(g.key)}>{String(g.name ?? g.key)}</option>
              ))}
            </select>
            <select name="delivery" defaultValue={deliveryKey ?? ""} style={{ maxWidth: 220 }}>
              <option value="">Any delivery</option>
              {DELIVERY.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
            <select name="engagement" defaultValue={engagementKey ?? ""} style={{ maxWidth: 220 }}>
              <option value="">Any response</option>
              {ENGAGEMENT.map((e) => (
                <option key={e.key} value={e.key}>{e.label}</option>
              ))}
            </select>
            {tab && <input type="hidden" name="tab" value={tab} />}
            <SubmitButton variant="quiet" icon={<Filter />} pendingLabel="Filtering…">Filter</SubmitButton>
          </form>

          {state && (
            <p className="sub" style={{ marginTop: -8 }}>
              <strong>{state}</strong> — {LIFECYCLE_COPY[state]}
            </p>
          )}

          {rows.length === 0 ? (
            <div className="empty">
              <strong>{everyone === 0 ? "Nobody here yet" : "Nobody matches that"}</strong>
              {everyone === 0
                ? "Add people directly, or run a campaign — everyone it touches lands here automatically."
                : "Try a different search, state, campaign, delivery or response."}
            </div>
          ) : (
            <>
              <div className="tw scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Person</th><th>State</th><th>Segment</th>
                      <th>What they did</th>
                      <th className="num">Attempts</th><th className="num">Invested</th><th>Last contacted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const belief = p.belief as { segment?: string } | undefined;
                      const inv = (p.investment ?? {}) as { messages?: number; usd?: number };
                      const life = String(p.lifecycle ?? "new");
                      return (
                        <tr key={String(p._id)}>
                          <td>
                            <a href={`${base}/${String(p._id)}`}>
                              <strong>{String(p.name ?? p.primaryEmail)}</strong>
                            </a>
                            <div className="muted" style={{ fontSize: 12.5 }}>{String(p.primaryEmail ?? "")}</div>
                          </td>
                          <td>
                            <span className={`pill ${life === "suppressed" ? "bad" : life === "active" ? "ok" : ""}`}>
                              {life}
                            </span>
                          </td>
                          <td>{belief?.segment ?? <ClaudeBadge note="next run" />}</td>
                          {/* What they did back, as against what we did to them. This was a
                              date, which reports that something happened and refuses to say
                              what — a click and an image prefetch rendered identically. */}
                          <td>
                            <Responded engagement={engaged.get(String(p._id))} />
                          </td>
                          <td className="num">{Number(p.attempts ?? 0)}</td>
                          <td className="num">
                            {Number(inv.messages ?? 0)} msg
                            <div className="muted">${Number(inv.usd ?? 0).toFixed(2)}</div>
                          </td>
                          <td className="muted num">
                            {istDay(p.lastContactedAt as string, "never")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="sub">{rows.length} of {total} shown.</p>
            </>
          )}
        </>
      ) : sized.length === 0 ? (
        <div className="empty">
          <strong>No groups yet</strong>
          A group is a filter over the people tab — a static one is a list you picked, a dynamic one keeps
          re-evaluating so a campaign never runs out.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr><th>Group</th><th>Kind</th><th>Who is in it</th><th className="num">People</th><th /></tr>
            </thead>
            <tbody>
              {sized.map(({ audience, size }) => (
                <tr key={String(audience._id)}>
                  <td>
                    <strong>{String(audience.name)}</strong>
                    {audience.description ? (
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(audience.description)}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`pill ${audience.kind === "dynamic" ? "accent" : ""}`}>
                      {String(audience.kind)}
                    </span>
                  </td>
                  <td className="muted">{describe(audience.filter as Record<string, unknown> | undefined)}</td>
                  <td className="num">{size}</td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                      <AudienceDrawer
                        productId={id}
                        action={saveAudience}
                        label="Edit"
                        existing={{
                          id: String(audience._id),
                          name: String(audience.name),
                          description: audience.description ? String(audience.description) : undefined,
                          kind: String(audience.kind),
                          filter: audience.filter as Record<string, unknown> | undefined,
                        }}
                      />
                      <ConfirmButton
                        title={`Delete "${String(audience.name)}"?`}
                        body="The group goes; the people in it stay. Any campaign pointed at it loses its input."
                        confirmLabel="Delete group"
                        action={deleteAudience.bind(null, id, String(audience._id))}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * One person's response, in the order it matters: a reply outranks a click, a click
 * outranks an open, and an open is labelled as the guess it is.
 *
 * Silence is spelled out rather than left blank. An empty cell reads as missing data; "no
 * response yet" reads as the fact it is, and is the answer for most rows on most days.
 */
function Responded({ engagement }: { engagement?: { opened: number; clicked: number; replied: number; lastOpenedAt?: Date; lastClickedAt?: Date; lastRepliedAt?: Date } }) {
  if (!engagement || engagement.replied + engagement.clicked + engagement.opened === 0) {
    return <span className="muted">no response yet</span>;
  }
  return (
    <div className="responded">
      {engagement.replied > 0 && (
        <span className="pill ok" title={`Last reply ${ist(engagement.lastRepliedAt)}`}>
          <MessageSquare /> replied{engagement.replied > 1 ? ` ×${engagement.replied}` : ""}
        </span>
      )}
      {engagement.clicked > 0 && (
        <span className="pill hot" title={`Last click ${ist(engagement.lastClickedAt)}`}>
          <MousePointerClick /> clicked{engagement.clicked > 1 ? ` ×${engagement.clicked}` : ""}
        </span>
      )}
      {engagement.opened > 0 && (
        <span className="pill warm" title={`Opens are unreliable — clients prefetch images. Last ${ist(engagement.lastOpenedAt)}`}>
          <Mail /> opened{engagement.opened > 1 ? ` ×${engagement.opened}` : ""}
        </span>
      )}
    </div>
  );
}
