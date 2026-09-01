import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { getProduct, requireSession, scope } from "../../tenant";

export const dynamic = "force-dynamic";

/** Anything a person can actually do something about. Nothing else earns a place here. */
interface Alert {
  text: string;
  href: string;
  action: string;
}

export default async function ProductHome({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const product = await getProduct(id, orgId);
  if (!product) return null;

  const db = await getDb();
  const s = scope(orgId, id);
  const base = `/products/${id}`;

  const [people, inFlight, sent, queued, held, failed, channels, goals, sources, templates, unclassified] =
    await Promise.all([
      db.collection(C.people).countDocuments(s),
      db.collection(C.goalInstances).countDocuments({ ...s, status: "active" }),
      db.collection(C.actions).countDocuments({ ...s, status: "sent" }),
      db.collection(C.actions).countDocuments({ ...s, status: "queued" }),
      db.collection(C.actions).countDocuments({ ...s, status: "awaiting_approval" }),
      db.collection(C.actions).countDocuments({ ...s, status: "failed" }),
      db.collection(C.channels).find(s).toArray(),
      db.collection(C.goals).countDocuments(s),
      db.collection(C.sources).find(s).toArray(),
      db.collection(C.templates).countDocuments(s),
      db.collection(C.people).countDocuments({ ...s, needsClassification: true }),
    ] as const);

  const alerts: Alert[] = [];
  if (held > 0) {
    alerts.push({
      text: `${held} message${held === 1 ? "" : "s"} waiting for you to review`,
      href: `${base}/review`,
      action: "Review",
    });
  }
  for (const channel of channels.filter((c) => c.status !== "healthy")) {
    alerts.push({
      text: `The ${String(channel.key)} channel is ${String(channel.status)}`,
      href: `${base}/channels`,
      action: "Fix",
    });
  }
  for (const source of sources.filter((src) => (src.health as { status?: string } | undefined)?.status === "degraded")) {
    alerts.push({
      text: `Source "${String(source.name)}" is failing`,
      href: `${base}/goals`,
      action: "Open",
    });
  }
  if (failed > 0) {
    alerts.push({ text: `${failed} message${failed === 1 ? "" : "s"} failed to send`, href: `${base}/leads`, action: "Inspect" });
  }

  // Setup is a chain: each step is pointless until the one above it is done.
  const setup = [
    { done: channels.length > 0, label: "Connect a channel", href: `${base}/channels` },
    { done: templates > 0, label: "Generate templates", href: `${base}/templates` },
    { done: goals > 0, label: "Create a goal", href: `${base}/goals` },
    { done: sources.length > 0, label: "Give that goal an input", href: `${base}/goals` },
  ];
  const incomplete = setup.filter((x) => !x.done);

  const cfg = product.config as {
    oneLiner?: string;
    activation?: { describedAs?: string };
    segments?: Array<{ key: string; name: string; pain: string }>;
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>{String(product.name)}</h1>
          <p className="sub" style={{ marginBottom: 0 }}>{cfg.oneLiner}</p>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="band">
          <strong>Needs you</strong>
          <ul>
            {alerts.map((a) => (
              <li key={a.text}>
                {a.text} — <a href={a.href}>{a.action}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {incomplete.length > 0 && (
        <div className="note">
          <p style={{ marginBottom: 6 }}><strong>Finish setting up</strong></p>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {setup.map((x) => (
              <li key={x.label} style={{ color: x.done ? "var(--ink-3)" : undefined }}>
                {x.done ? <s>{x.label}</s> : <a href={x.href}>{x.label}</a>}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="grid" style={{ marginBottom: 26 }}>
        <Stat label="People" value={people} />
        <Stat label="In flight" value={inFlight} />
        <Stat label="Queued" value={queued} />
        <Stat label="Sent" value={sent} />
      </div>

      <h2>Activation</h2>
      <p>{cfg.activation?.describedAs ?? "Not defined yet."}</p>
      <p className="sub">
        Every goal aims at this, not at signup. An activated trial converts several times better than an
        inactive one, so this line matters more than any other in the config.
      </p>

      <h2>Segments</h2>
      {!cfg.segments?.length ? (
        <div className="empty">
          <strong>No segments yet</strong>
          They drive which template variant each person gets. Add them in <a href={`${base}/settings`}>settings</a>.
        </div>
      ) : (
        <div className="tw scroll">
          <table>
            <thead><tr><th>Segment</th><th>What they are stuck on</th></tr></thead>
            <tbody>
              {cfg.segments.map((seg) => (
                <tr key={seg.key}>
                  <td><strong>{seg.name}</strong><div className="muted" style={{ fontSize: 12.5 }}><code>{seg.key}</code></div></td>
                  <td className="muted">{seg.pain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unclassified > 0 && (
        <p className="sub">
          {unclassified} {unclassified === 1 ? "person is" : "people are"} waiting to be classified. Claude does
          that on its next run — see <a href={`${base}/claude`}>Claude</a>.
        </p>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
