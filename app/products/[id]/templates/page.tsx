import { ObjectId } from "mongodb";
import { RefreshCw } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { loadBrandKit } from "@/engine/brand.js";
import { renderTemplate, type MergeVars } from "@/engine/compose.js";
import { validate } from "@/engine/validate.js";
import { rate, templatePerformance, type TemplatePerformance } from "@/engine/engagement.js";
import { anglePerformance } from "@/engine/outcomes.js";
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

  const [templates, product, people, kit, brandSources, earned, angles] = await Promise.all([
    db.collection(C.templates).find(s).sort({ channel: 1, scope: 1 }).toArray(),
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }),
    db.collection(C.people).find(s).sort({ createdAt: -1 }).limit(25).toArray(),
    loadBrandKit(orgId, id),
    db.collection(C.brandSources).countDocuments(s),
    // What each of these has actually earned. Without it this page shows what a message
    // would look like and never whether it worked, which is the question being asked.
    templatePerformance(orgId, id),
    anglePerformance(orgId, id),
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
    // A preview never signs anything. The real value comes from mergeVarsFor at send time;
    // this only stops the field showing as an unmerged {{visit_token}} on screen.
    visit_token: "sample-token",
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
                  <th>What it earned</th>
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
                        <Earned performance={earned.get(String(t._id))} />
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

          {/* The same record cut the other way. A template is a piece of writing; an angle
              is the argument inside it, and the argument is what carries across templates
              and segments. This existed only as a tool a model could call — the person
              deciding what to write next could not see it at all. */}
          {angles.length > 0 && (
            <>
              <h2>Which arguments earn a click</h2>
              <p className="sub">
                Every send grouped by the angle it took and the segment it went to. Rates appear once a row has
                enough tracked sends to mean anything — below that the counts stand on their own.
              </p>
              <div className="tw scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Angle</th>
                      <th>Segment</th>
                      <th className="num">Sent</th>
                      <th className="num">Clicked</th>
                      <th className="num">Replied</th>
                      <th className="num">Won</th>
                      <th>Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {angles.map((a) => (
                      <tr key={`${a.angle}:${a.segment}:${a.channel}`}>
                        <td><strong>{a.angle.replace(/_/g, " ")}</strong>
                          <span className="cell-sub">{a.channel}</span>
                        </td>
                        <td>{a.segment.replace(/_/g, " ")}</td>
                        <td className="num">{a.sent}</td>
                        <td className="num">
                          {a.clicked}
                          {a.trackable >= ENOUGH_TO_RATE && (
                            <div className="muted">{rate(a.clicked, a.trackable)}</div>
                          )}
                        </td>
                        <td className="num">{a.replied}</td>
                        <td className="num">{a.won}</td>
                        <td className="muted">{verdict(a)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}

/**
 * What a row is allowed to claim.
 *
 * The honest answer for almost every row in a young product is "not enough sends yet", and
 * saying so is the point: a nought per cent from four messages reads as a dead angle and
 * gets a working one rewritten.
 */
function verdict(row: { sent: number; trackable: number; clicked: number; won: number }): string {
  if (row.won > 0) return `${row.won} campaign${row.won === 1 ? "" : "s"} finished on this angle`;
  if (row.trackable < ENOUGH_TO_RATE) return `too few sends to judge — ${row.trackable} tracked`;
  if (row.clicked === 0) return "nobody has clicked this one";
  return `${rate(row.clicked, row.trackable)} of tracked sends clicked`;
}

/**
 * One template's record, in the order a writer cares about: how many people it reached,
 * then how many of them did anything.
 *
 * A rate needs a denominator worth trusting, so it appears only once enough messages have
 * gone out for the number to mean something. Below that the counts are shown plainly —
 * "1 of 3" is a fact, "33%" from three sends is a claim the data cannot support.
 */
const ENOUGH_TO_RATE = 20;

function Earned({ performance }: { performance?: TemplatePerformance }) {
  if (!performance || performance.sent === 0) {
    return <span className="muted">never sent</span>;
  }

  const { sent, trackable, clicked, replied, won, machineClicked } = performance;
  return (
    <div className="responses">
      <span className="status muted">{sent} sent</span>
      <span className={`status ${clicked > 0 ? "live" : "muted"}`}>
        {clicked} clicked
        {trackable >= ENOUGH_TO_RATE && <span className="muted"> · {rate(clicked, trackable)}</span>}
      </span>
      {replied > 0 && <span className="status live">{replied} replied</span>}
      {won > 0 && <span className="status live">{won} won</span>}
      {trackable > 0 && trackable < ENOUGH_TO_RATE && (
        <span className="status unmeasured" title={`Only ${trackable} tracked sends — too few for a rate to mean anything.`}>
          too few to rate
        </span>
      )}
      {machineClicked > 0 && (
        <span className="status muted" title="Mail-gateway fetches, excluded from the click count.">
          {machineClicked} scanner
        </span>
      )}
    </div>
  );
}
