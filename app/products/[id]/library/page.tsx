import { Filter, Layers, Search, Users } from "lucide-react";
import { audienceCount, queryLibrary, type DeliveryState } from "@/engine/library.js";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { deleteAudience, importPeople, saveAudience } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ClaudeBadge from "../../../ui/claude-badge";
import ConfirmButton from "../../../ui/confirm";
import { SubmitButton, Tabs } from "../../../ui/kit";
import AudienceDrawer from "../audiences/audience-drawer";
import ImportDrawer from "./import-drawer";
import { istDay } from "../../../ui/time";

export const dynamic = "force-dynamic";

const STATES = ["new", "active", "cooling", "dormant", "suppressed"] as const;

const DELIVERY: Array<{ key: DeliveryState; label: string }> = [
  { key: "sent", label: "sent — handed to the provider" },
  { key: "delivered", label: "delivered — provider confirmed" },
  { key: "failed", label: "failed" },
  { key: "pending", label: "not sent yet" },
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
  searchParams: Promise<{ q?: string; state?: string; campaign?: string; delivery?: string; tab?: string }>;
}) {
  const { id } = await params;
  const { q, state, campaign, delivery, tab } = await searchParams;
  const deliveryKey = DELIVERY.find((d) => d.key === delivery)?.key;
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
                : "Try a different search, state, campaign or delivery."}
            </div>
          ) : (
            <>
              <div className="tw scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Person</th><th>State</th><th>Segment</th>
                      <th className="num">Attempts</th><th className="num">Invested</th><th>Last contacted</th>
                      <th>Last engaged</th>
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
                          <td className="num">{Number(p.attempts ?? 0)}</td>
                          <td className="num">
                            {Number(inv.messages ?? 0)} msg
                            <div className="muted">${Number(inv.usd ?? 0).toFixed(2)}</div>
                          </td>
                          <td className="muted num">
                            {istDay(p.lastContactedAt as string, "never")}
                          </td>
                          {/* What they did back, as against what we did to them. The two
                              columns side by side are the whole read on a lead. */}
                          <td className="muted num">
                            {istDay(p.lastSignalAt as string, "never")}
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
