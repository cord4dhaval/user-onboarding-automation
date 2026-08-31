import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { generateTemplates } from "../../../actions";
import { scope } from "../../../tenant";

export const dynamic = "force-dynamic";

export default async function Templates({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const templates = await db.collection(C.templates).find(scope(id)).sort({ channel: 1, scope: 1 }).toArray();

  return (
    <main>
      <h1>Templates</h1>
      <p className="sub">
        Skeletons with slots, not stored copy. Fixed blocks are yours and never touched; slots are written per
        person, falling back to deterministic text when a touch must fire before any session has run.
      </p>

      <form action={generateTemplates.bind(null, id)}>
        <button className="ghost" type="submit">
          {templates.length ? "Regenerate defaults from config" : "Generate defaults from config"}
        </button>
      </form>

      <div style={{ marginTop: 20 }}>
        {templates.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          templates.map((t) => (
            <div className="card" key={String(t._id)} style={{ marginBottom: 12 }}>
              <div className="label">
                {String(t.key)} · {String(t.channel)} · {String(t.scope)}
                {t.segmentKey ? ` · ${String(t.segmentKey)}` : ""}
              </div>
              <table>
                <tbody>
                  {(t.blocks as Array<Record<string, unknown>>).map((b, i) => (
                    <tr key={i}>
                      <th style={{ width: 90 }}>{String(b.type)}</th>
                      <td>
                        {b.fixed ? (
                          <span>{String(b.fixed)}</span>
                        ) : (
                          <>
                            <span className="muted">{String(b.slot ?? b.instruct ?? "")}</span>
                            {b.fallback ? (
                              <div style={{ marginTop: 4 }}>
                                <span className="pill">fallback</span> {String(b.fallback)}
                              </div>
                            ) : null}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
