import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import {scope, requireSession} from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Leads({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);
  const people = await db.collection(C.people).find(s).sort({ createdAt: -1 }).limit(100).toArray();

  const rows = await Promise.all(
    people.map(async (p) => {
      const [goal, actions] = await Promise.all([
        db.collection(C.goalInstances).findOne({ ...s, personId: String(p._id), status: "active" }),
        db.collection(C.actions).find({ ...s, personId: String(p._id) }).sort({ dueAt: 1 }).toArray(),
      ]);
      return { person: p, goal, actions };
    }),
  );

  return (
    <main>
      <h1>Leads</h1>
      <p className="sub">
        Belief and temperature are derived. To correct one, submit evidence rather than overwriting it — the
        correction becomes an event and a training signal.
      </p>

      {rows.length === 0 ? (
        <p className="empty">No leads yet. Run a source.</p>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr><th>Person</th><th>Segment</th><th>Temp</th><th>Goal</th><th>Touches</th><th>Last action</th></tr>
            </thead>
            <tbody>
              {rows.map(({ person, goal, actions }) => {
                const belief = person.belief as { segment: string; confidence: number } | undefined;
                const temp = person.temp as { band: string; score: number } | undefined;
                const spent = (goal?.spent as { touches: number } | undefined)?.touches ?? 0;
                const last = actions[actions.length - 1];
                return (
                  <tr key={String(person._id)}>
                    <td>
                      <strong>{String(person.name ?? "—")}</strong>
                      <br />
                      <span className="muted">{String(person.primaryEmail ?? "")}</span>
                    </td>
                    <td>
                      {belief
                        ? <>{belief.segment} <span className="muted">{Math.round(belief.confidence * 100)}%</span></>
                        : <span className="pill warn">unclassified</span>}
                    </td>
                    <td>{temp ? <span className="pill">{temp.band} {Math.round(temp.score)}</span> : "—"}</td>
                    <td>{goal ? <code>{String(goal.goalKey)}</code> : <span className="muted">none</span>}</td>
                    <td>{spent}</td>
                    <td className="muted">
                      {last
                        ? <>{String(last.channel)} · <span className={last.status === "sent" ? "ok" : ""}>{String(last.status)}</span></>
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
