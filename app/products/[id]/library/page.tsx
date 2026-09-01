import { queryLibrary } from "@/engine/library.js";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { importPeople } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import ClaudeBadge from "../../../ui/claude-badge";
import ImportDrawer from "./import-drawer";

export const dynamic = "force-dynamic";

const STATES = ["new", "active", "cooling", "dormant", "suppressed"] as const;

const LIFECYCLE_COPY: Record<string, string> = {
  new: "never contacted",
  active: "a campaign is working on them",
  cooling: "an attempt ended, resting",
  dormant: "several attempts spent",
  suppressed: "said no — permanent",
};

export default async function Library({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; state?: string }>;
}) {
  const { id } = await params;
  const { q, state } = await searchParams;
  const { orgId } = await requireSession();
  const s = scope(orgId, id);

  const { rows, total } = await queryLibrary(orgId, id, {
    search: q,
    lifecycle: state ? [state] : undefined,
    limit: 100,
  });

  const db = await getDb();
  const counts = Object.fromEntries(
    await Promise.all(
      STATES.map(async (st) => [st, await db.collection(C.people).countDocuments({ ...s, lifecycle: st })] as const),
    ),
  );
  const everyone = await db.collection(C.people).countDocuments(s);

  return (
    <>
      <div className="head">
        <div>
          <h1>Library</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            Everyone this product has ever touched. Campaigns write people in as they arrive; audiences read
            them back out. Nobody is ever deleted — someone who says no is suppressed, so they can never be
            picked up again by accident.
          </p>
        </div>
        <div className="spacer" />
        <ImportDrawer productId={id} action={importPeople} />
      </div>

      <form method="get" className="row" style={{ marginBottom: 18 }}>
        <input name="q" defaultValue={q ?? ""} placeholder="Search name, email or company" style={{ maxWidth: 320 }} />
        <select name="state" defaultValue={state ?? ""} style={{ maxWidth: 200 }}>
          <option value="">Everyone ({everyone})</option>
          {STATES.map((st) => (
            <option key={st} value={st}>{st} ({counts[st] ?? 0})</option>
          ))}
        </select>
        <button className="quiet" type="submit">Filter</button>
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
            : "Try a different search or state."}
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr>
                <th>Person</th><th>State</th><th>Segment</th><th>Attempts</th>
                <th>Invested</th><th>Last contacted</th>
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
                      <a href={`/products/${id}/library/${String(p._id)}`}>
                        <strong>{String(p.name ?? p.primaryEmail)}</strong>
                      </a>
                      <div className="muted" style={{ fontSize: 12.5 }}>{String(p.primaryEmail ?? "")}</div>
                    </td>
                    <td>
                      <span className={`pill ${life === "suppressed" ? "bad" : life === "active" ? "ok" : ""}`}>
                        {life}
                      </span>
                    </td>
                    <td>
                      {belief?.segment ?? <ClaudeBadge note="next run" />}
                    </td>
                    <td className="num">{Number(p.attempts ?? 0)}</td>
                    <td className="num">
                      {Number(inv.messages ?? 0)} msg
                      <div className="muted">${Number(inv.usd ?? 0).toFixed(2)}</div>
                    </td>
                    <td className="muted num">
                      {p.lastContactedAt
                        ? new Date(String(p.lastContactedAt)).toISOString().slice(0, 10)
                        : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="sub">{rows.length} of {total} shown.</p>
    </>
  );
}
