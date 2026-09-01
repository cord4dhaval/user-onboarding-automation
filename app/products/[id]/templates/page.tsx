import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { renderTemplate, type MergeVars } from "@/engine/compose.js";
import { validate } from "@/engine/validate.js";
import { generateTemplates } from "../../../actions";
import { requireSession, scope } from "../../../tenant";

export const dynamic = "force-dynamic";

/** Stand-in used when the product has no leads yet, so preview always has something to show. */
const SAMPLE = {
  name: "Priya Nair",
  primaryEmail: "priya@cloudnine.dev",
  companyDomain: "cloudnine.dev",
  _id: "sample",
};

export default async function Templates({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lead?: string }>;
}) {
  const { id } = await params;
  const { lead } = await searchParams;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [templates, product, people] = await Promise.all([
    db.collection(C.templates).find(s).sort({ channel: 1, scope: 1 }).toArray(),
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }),
    db.collection(C.people).find(s).sort({ createdAt: -1 }).limit(25).toArray(),
  ]);

  const selected =
    (lead && lead !== "sample" ? people.find((p) => String(p._id) === lead) : undefined) ??
    people[0] ??
    SAMPLE;

  const name = String(selected.name ?? "");
  const trialTemplate = String(
    (product?.config as { trialLinkTemplate?: string })?.trialLinkTemplate ?? "https://example.com/start",
  );
  const personId = String(selected._id);

  const vars: MergeVars = {
    first_name: name.split(" ")[0] || "there",
    full_name: name,
    company: String(selected.companyDomain ?? "").split(".")[0] || "your team",
    trial_link: trialTemplate.replace("{{person_id}}", personId),
    opt_out_url: `https://example.com/unsubscribe?p=${personId}`,
  };

  return (
    <main>
      <h1>Templates</h1>
      <p className="sub">
        Skeletons with slots, not stored copy. Fixed blocks are yours and never touched; slots are written per
        person, falling back to deterministic text when a touch must fire before any session has run.
      </p>

      <form method="get" className="stack" style={{ maxWidth: 420, marginBottom: 20 }}>
        <label>
          Preview against
          <select name="lead" defaultValue={personId}>
            <option value="sample">Sample lead — Priya Nair</option>
            {people.map((p) => (
              <option key={String(p._id)} value={String(p._id)}>
                {String(p.name ?? p.primaryEmail)}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost" type="submit">Preview</button>
      </form>

      <form action={generateTemplates.bind(null, id)}>
        <button className="ghost" type="submit">
          {templates.length ? "Regenerate defaults from config" : "Generate defaults from config"}
        </button>
      </form>

      <div style={{ marginTop: 24 }}>
        {templates.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          templates.map((t) => {
            const blocks = t.blocks as Array<Record<string, unknown>>;
            // Exactly what the engine would produce for this person, fallbacks included.
            const rendered = renderTemplate(blocks, vars);
            const constraints = t.constraints as { maxWords?: number; noClaims?: string[] } | undefined;
            const check = validate(rendered, {
              channelKey: String(t.channel),
              maxWords: constraints?.maxWords,
              noClaims: constraints?.noClaims,
            });

            return (
              <div className="card" key={String(t._id)} style={{ marginBottom: 20 }}>
                <div className="label">
                  {String(t.key)} · {String(t.channel)} · {String(t.scope)}
                  {t.segmentKey ? ` · ${String(t.segmentKey)}` : ""}
                </div>

                <h3 style={{ margin: "10px 0 6px", fontSize: 14 }}>Preview</h3>
                <div className="preview">
                  <div className="preview-head">
                    <span className="muted">To</span> {String(selected.primaryEmail ?? "—")}
                  </div>
                  {rendered.subject && (
                    <div className="preview-head">
                      <span className="muted">Subject</span> <strong>{rendered.subject}</strong>
                    </div>
                  )}
                  <div className="preview-body">{rendered.bodyMd}</div>
                </div>

                <p className="sub" style={{ margin: "8px 0 0" }}>
                  {rendered.wordCount} words ·{" "}
                  {check.ok ? (
                    <span className="pill ok">would send</span>
                  ) : (
                    <span className="pill err">blocked: {check.hardFails.join("; ")}</span>
                  )}
                  {check.softFails.length > 0 && (
                    <> · <span className="pill warn">{check.softFails.join("; ")}</span></>
                  )}
                </p>

                <details style={{ marginTop: 12 }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Blocks</summary>
                  <table style={{ marginTop: 8 }}>
                    <tbody>
                      {blocks.map((b, i) => (
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
                </details>
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}
