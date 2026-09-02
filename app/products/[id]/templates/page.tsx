import { ObjectId } from "mongodb";
import { RefreshCw } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { loadBrandKit } from "@/engine/brand.js";
import { renderTemplate, type MergeVars } from "@/engine/compose.js";
import { validate } from "@/engine/validate.js";
import { createTemplate, generateTemplates } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import BrandBadge from "../../../ui/brand-badge";
import ClaudeBadge from "../../../ui/claude-badge";
import { ActionButton } from "../../../ui/kit";
import TemplateDrawer from "./template-drawer";

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

  const [templates, product, people, kit, brandSources] = await Promise.all([
    db.collection(C.templates).find(s).sort({ channel: 1, scope: 1 }).toArray(),
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }),
    db.collection(C.people).find(s).sort({ createdAt: -1 }).limit(25).toArray(),
    loadBrandKit(orgId, id),
    db.collection(C.brandSources).countDocuments(s),
  ]);

  const selected =
    (lead && lead !== "sample" ? people.find((p) => String(p._id) === lead) : undefined) ??
    people[0] ??
    SAMPLE;

  const name = String(selected.name ?? "");
  const config = (product?.config ?? {}) as {
    website?: string;
    trialLinkTemplate?: string;
    segments?: Array<{ key: string }>;
  };
  const personId = String(selected._id);
  const site = (config.website ?? "https://example.com").replace(/\/$/, "");
  const vars: MergeVars = {
    first_name: name.split(" ")[0] || "there",
    full_name: name,
    company: String(selected.companyDomain ?? "").split(".")[0] || "your team",
    person_id: personId,
    trial_link: (config.trialLinkTemplate ?? `${site}/start?p={{person_id}}`).replace("{{person_id}}", personId),
    opt_out_url: `${site}/unsubscribe?p=${personId}`,
  };

  const branded = Object.keys(kit.provenance ?? {}).length > 0;

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Templates</h1>
          <p className="sub">
            Skeletons with slots, not stored copy. Fixed blocks are yours and never touched; slots are written
            per person. Appearance comes from the <a href={`/products/${id}/brand`}>brand kit</a> at render time,
            so one palette change restyles every template here.
          </p>
        </div>
        <div className="row">
          <ActionButton
            variant="quiet"
            icon={<RefreshCw />}
            action={generateTemplates.bind(null, id)}
            pendingLabel="Generating"
          >
            {templates.length ? "Regenerate defaults" : "Generate defaults"}
          </ActionButton>
          <TemplateDrawer
            productId={id}
            action={createTemplate}
            segmentKeys={(config.segments ?? []).map((segment) => segment.key)}
          />
        </div>
      </header>

      {!branded && <BrandBadge productId={id} state={{ branded, sources: brandSources }} />}

      {templates.length === 0 ? (
        <p className="empty">
          <strong>No templates yet.</strong>
          Generate the starter set from the product config, or write one from scratch.
        </p>
      ) : (
        <>
          <form method="get" className="toolbar">
            <label className="inline">
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
            <button type="submit" className="quiet sm">
              Apply
            </button>
          </form>

          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Channel</th>
                  <th>Sends as</th>
                  <th>Scope</th>
                  <th>Preview</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const blocks = t.blocks as Array<Record<string, unknown>>;
                  // Exactly what the engine would produce for this person, fallbacks included.
                  const rendered = renderTemplate(blocks, vars);
                  const constraints = t.constraints as { maxWords?: number; noClaims?: string[] } | undefined;
                  const chk = validate(rendered, {
                    channelKey: String(t.channel),
                    maxWords: constraints?.maxWords,
                    noClaims: constraints?.noClaims,
                  });
                  const sendsHtml =
                    String(t.channel) === "email" && String(t.format ?? "html") !== "text";

                  return (
                    <tr key={String(t._id)}>
                      <td>
                        <a href={`/products/${id}/templates/${String(t._id)}`} className="strong-link">
                          {String(t.name ?? t.key)}
                        </a>
                        <span className="cell-sub">
                          <code>{String(t.key)}</code>
                          {t.createdBy === "claude" && <ClaudeBadge note="drafted" />}
                        </span>
                      </td>
                      <td>{String(t.channel)}</td>
                      <td>
                        <span className="pill accent">{sendsHtml ? "HTML" : "text"}</span>
                      </td>
                      <td>
                        {String(t.scope)}
                        {t.segmentKey ? <span className="cell-sub">{String(t.segmentKey)}</span> : null}
                      </td>
                      <td className="cell-wide">
                        {rendered.subject && <strong>{rendered.subject}</strong>}
                        <span className="clamp">{rendered.bodyMd.replace(/\n+/g, " ")}</span>
                        <span className="cell-sub">
                          {blocks.length} blocks · {rendered.wordCount} words
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${t.status === "active" ? "ok" : ""}`}>{String(t.status)}</span>
                        {!chk.ok && <span className="pill bad">blocked</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
