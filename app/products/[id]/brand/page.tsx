import { ObjectId } from "mongodb";
import { Globe, RefreshCw } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { loadBrandKit } from "@/engine/brand.js";
import { resolveBlocks, type MergeVars } from "@/engine/compose.js";
import { renderHtml } from "@/engine/html.js";
import { addBrandSource, deleteBrandSource, detectBrandFromWebsite, refreshBrand, saveManualBrand } from "../../../actions";
import ConfirmButton from "../../../ui/confirm";
import BrandBadge from "../../../ui/brand-badge";
import { ActionButton } from "../../../ui/kit";
import { requireSession, scope } from "../../../tenant";
import { AddSourceDrawer, OverridesDrawer } from "./brand-drawers";

export const dynamic = "force-dynamic";

/** A fixed sample, so the preview shows the brand rather than the copy. */
const SAMPLE_BLOCKS: Record<string, unknown>[] = [
  { type: "heading", level: 1, fixed: "Your workspace is ready" },
  { type: "text", fixed: "Hi {{first_name}}," },
  {
    type: "slot",
    instruct: "sample",
    fallback:
      "Everything is set up. The first import takes about two minutes, and you can undo it afterwards if the mapping is wrong.",
  },
  {
    type: "list",
    style: "check",
    items: ["Import your first spreadsheet", "Pick one goal to chase", "Approve the opening message"],
  },
  { type: "cta", fixed: "Get started", url: "https://example.com" },
  { type: "divider" },
  {
    type: "card",
    title: "Your plan",
    rows: [
      { label: "Trial", value: "14 days, no card" },
      { label: "Seats", value: "Unlimited" },
    ],
    accent: true,
  },
  { type: "system", fixed: "opt_out_block" },
];

const SAMPLE_VARS: MergeVars = {
  first_name: "Priya",
  full_name: "Priya Nair",
  company: "cloudnine",
  person_id: "sample",
  trial_link: "https://example.com/start",
  opt_out_url: "https://example.com/unsubscribe",
};

export default async function Brand({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [kit, sources, product, connections] = await Promise.all([
    loadBrandKit(orgId, id),
    db.collection(C.brandSources).find(s).sort({ precedence: 1 }).toArray(),
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }),
    db.collection(C.connections).find({ orgId, productId: id }).toArray(),
  ]);

  const manual = sources.find((source) => source.kind === "manual");
  const literal = (manual?.literal ?? {}) as Record<string, Record<string, string>>;
  const website = (product?.config as { website?: string } | undefined)?.website;
  const branded = Object.keys(kit.provenance ?? {}).length > 0;
  const hasWebsiteSource = sources.some((source) => source.kind === "css_vars");

  const html = renderHtml(resolveBlocks(SAMPLE_BLOCKS, SAMPLE_VARS), kit);
  const swatches = Object.entries(kit.color).filter(([, value]) => typeof value === "string") as Array<
    [string, string]
  >;

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Brand</h1>
          <p className="sub">
            The visual half of brand, kept beside the voice already in the product config. Every email is
            assembled from these values at send time, so one change here restyles every template at once — and
            nothing is fetched while a message is being sent.
          </p>
        </div>
        <div className="row">
          <OverridesDrawer
            productId={id}
            action={saveManualBrand}
            current={{ color: literal.color, logo: literal.logo, font: literal.font, footer: literal.footer }}
          />
          <AddSourceDrawer
            productId={id}
            action={addBrandSource}
            connections={connections.map((connection) => ({
              id: String(connection._id),
              provider: String(connection.provider),
            }))}
          />
        </div>
      </header>

      {!branded && <BrandBadge productId={id} state={{ branded, sources: sources.length }} />}

      <div className="split">
        <section>
          <div className="section-head">
            <h2>Preview</h2>
            <BrandBadge productId={id} state={{ branded, sources: sources.length, accent: kit.color.accent }} compact />
          </div>
          <div className="preview">
            <iframe title="Branded email preview" srcDoc={html} className="preview-frame tall" />
          </div>
          <p className="stat-row">
            <span>sample copy, real brand</span>
            <span>{Math.round(html.length / 1024)}KB</span>
            <span className="muted">Gmail clips past 102KB</span>
          </p>
        </section>

        <section>
          <h2>Resolved kit</h2>
          <p className="sub">What the renderer will use, after every source has been merged.</p>
          <div className="row swatches">
            {swatches.map(([name, value]) => (
              <span key={name} className="swatch" title={`${name} — ${value}`}>
                <span className="chip" data-colour={value} style={{ background: value }} />
                {name}
              </span>
            ))}
          </div>
          <dl className="facts">
            <div>
              <dt>Heading</dt>
              <dd>{kit.font.headingStack.split(",")[0]}</dd>
            </div>
            <div>
              <dt>Body</dt>
              <dd>{kit.font.bodyStack.split(",")[0]}</dd>
            </div>
            <div>
              <dt>Corner radius</dt>
              <dd>{kit.shape.radius}px</dd>
            </div>
            <div>
              <dt>Logo</dt>
              <dd>{kit.logo ? "set" : <span className="muted">none — wordmark used</span>}</dd>
            </div>
            <div>
              <dt>Legal name</dt>
              <dd>{kit.footer.legalName || <span className="muted">not set</span>}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="section-head">
        <h2>Sources</h2>
        {website && !hasWebsiteSource && (
          <ActionButton
            variant="quiet"
            size="sm"
            icon={<Globe />}
            action={detectBrandFromWebsite.bind(null, id)}
            pendingLabel="Reading"
          >
            Read {new URL(website).hostname}
          </ActionButton>
        )}
      </div>
      <p className="sub">
        Merged lowest precedence first, so a palette can come from a provider while the logo comes from your own
        CDN and one value is corrected by hand.
      </p>

      {sources.length === 0 ? (
        <p className="empty">
          <strong>Nothing connected.</strong>
          {website
            ? "Reading your own website is the fastest start — no account anywhere."
            : "Add a website to the product config, or add a source above."}
        </p>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Precedence</th>
                <th>Contributes</th>
                <th>Health</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const resolved = (source.resolved ?? {}) as Record<string, unknown>;
                const health = source.health as { status?: string; error?: string } | undefined;
                return (
                  <tr key={String(source._id)}>
                    <td>
                      <strong>{String(source.name)}</strong>
                      {source.url ? (
                        <span className="cell-sub">
                          <code>{String(source.url)}</code>
                        </span>
                      ) : null}
                    </td>
                    <td>{String(source.kind)}</td>
                    <td>{String(source.precedence)}</td>
                    <td>
                      {Object.keys(resolved).length ? (
                        Object.keys(resolved).join(", ")
                      ) : (
                        <span className="muted">nothing</span>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${health?.status === "healthy" ? "ok" : "warn"}`}>
                        {health?.status ?? "pending"}
                      </span>
                      {health?.error && <span className="cell-sub">{health.error}</span>}
                    </td>
                    <td>
                      <span className="row">
                        <ActionButton
                          variant="quiet"
                          size="sm"
                          icon={<RefreshCw />}
                          aria-label={`Refresh ${String(source.name)}`}
                          action={refreshBrand.bind(null, id, String(source._id))}
                        />
                        <ConfirmButton
                          title={`Remove ${String(source.name)}?`}
                          body="The values it contributed drop out of the kit on the next render. Other sources are untouched."
                          confirmLabel="Remove"
                          action={deleteBrandSource.bind(null, id, String(source._id))}
                        />
                      </span>
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
