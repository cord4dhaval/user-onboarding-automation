import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { generateTemplates, saveProductConfig } from "../../actions";
import {getProduct, scope, requireSession} from "../../tenant";

export const dynamic = "force-dynamic";

export default async function ProductOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const product = await getProduct(id, orgId);
  if (!product) return null;

  const cfg = product.config as {
    oneLiner?: string;
    segments?: Array<{ key: string; name: string; useCase: string; pain: string; preferredChannels: string[] }>;
    suggestedChannels?: Array<{ key: string; why: string; priority: number }>;
    activation?: { describedAs: string };
  };

  const db = await getDb();
  const s = scope(orgId, id);
  const [templates, channels, connections, sources, goals, people, sent] = await Promise.all([
    db.collection(C.templates).countDocuments(s),
    db.collection(C.channels).find(s).toArray(),
    db.collection(C.connections).countDocuments(s),
    db.collection(C.sources).countDocuments(s),
    db.collection(C.goals).countDocuments(s),
    db.collection(C.people).countDocuments(s),
    db.collection(C.actions).countDocuments({ ...s, status: "sent" }),
  ]);
  const connected = new Set(channels.map((c) => String(c.key)));

  const steps = [
    { done: connections > 0, label: "Connect an MCP server", href: `/products/${id}/connections/new` },
    { done: channels.length > 0, label: "Create a channel from it", href: `/products/${id}/channels` },
    { done: templates > 0, label: "Generate templates from the config", href: `/products/${id}/templates` },
    { done: goals > 0, label: "Define a goal", href: `/products/${id}/goals` },
    { done: sources > 0, label: "Point a source at that goal", href: `/products/${id}/sources` },
  ];

  return (
    <main>
      <h1>{String(product.name)}</h1>
      <p className="sub"><code>{String(product.slug)}</code> · v{String(product.version)} · {cfg.oneLiner}</p>

      <div className="grid">
        <Stat label="People" value={people} />
        <Stat label="Sent" value={sent} />
        <Stat label="Goals" value={goals} />
        <Stat label="Templates" value={templates} />
      </div>

      {steps.some((x) => !x.done) && (
        <div className="note">
          <strong>Setup</strong>
          <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {steps.map((x) => (
              <li key={x.label}>
                <a href={x.href}>{x.label}</a> — {x.done ? "done" : "not yet"}
              </li>
            ))}
          </ol>
        </div>
      )}

      <h2>Activation</h2>
      <p>{cfg.activation?.describedAs ?? "Not defined"}</p>
      <p className="sub">
        Every goal aims at this, not at signup. An activated trial converts several times better than an
        inactive one, so getting this right matters more than any other line of config.
      </p>

      <h2>Segments</h2>
      {!cfg.segments?.length ? (
        <p className="empty">None yet. Add them in the config below — they drive template variants.</p>
      ) : (
        <div className="tw">
          <table>
            <thead><tr><th>Segment</th><th>Use case</th><th>Pain</th><th>Channels</th></tr></thead>
            <tbody>
              {cfg.segments.map((seg) => (
                <tr key={seg.key}>
                  <td><strong>{seg.name}</strong><br /><span className="muted"><code>{seg.key}</code></span></td>
                  <td>{seg.useCase}</td>
                  <td className="muted">{seg.pain}</td>
                  <td>{seg.preferredChannels.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Suggested channels</h2>
      <p className="sub">
        Suggestions only. Connecting one needs authorisation — an OAuth click or a pasted key — which is always
        your step, never an automated one.
      </p>
      <div className="tw">
        <table>
          <thead><tr><th>Channel</th><th>Why</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(cfg.suggestedChannels ?? []).map((sug) => (
              <tr key={sug.key}>
                <td><strong>{sug.key}</strong></td>
                <td className="muted">{sug.why}</td>
                <td>
                  {connected.has(sug.key)
                    ? <span className="pill ok">connected</span>
                    : <span className="pill warn">not connected</span>}
                </td>
                <td>{!connected.has(sug.key) && <a href={`/products/${id}/connections/new`}>Connect</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Templates</h2>
      <form action={generateTemplates.bind(null, id)}>
        <button className="ghost" type="submit">
          {templates ? `Regenerate ${templates} defaults from config` : "Generate default templates"}
        </button>
      </form>

      <h2>Config</h2>
      <p className="sub">
        The whole product-specific surface. Everything else in the engine is generic — adding another product
        is this document plus its connections.
      </p>
      <form action={saveProductConfig} className="stack" style={{ maxWidth: "100%" }}>
        <input type="hidden" name="productId" value={id} />
        <textarea name="config" defaultValue={JSON.stringify(product.config, null, 2)} style={{ minHeight: 420 }} />
        <button type="submit">Save config</button>
      </form>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
