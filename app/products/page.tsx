import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { createProduct } from "../actions";
import { ORG_ID } from "../tenant";

export const dynamic = "force-dynamic";

export default async function Products() {
  const db = await getDb();
  const products = await db.collection(C.products).find({ orgId: ORG_ID }).sort({ createdAt: 1 }).toArray();

  return (
    <main>
      <nav className="top">
        <span className="brand">Conversion Engine</span>
      </nav>

      <h1>Products</h1>
      <p className="sub">
        A product is the container for everything else — its config decides the segments, the templates and
        which channels are worth connecting. Connections, goals and leads all live inside one.
      </p>

      {products.length === 0 ? (
        <p className="empty">No products yet. Create your first below.</p>
      ) : (
        <div className="tw">
          <table>
            <thead><tr><th>Product</th><th>One-liner</th><th>Segments</th><th>Status</th></tr></thead>
            <tbody>
              {products.map((p) => {
                const cfg = p.config as { oneLiner?: string; segments?: unknown[] };
                return (
                  <tr key={String(p._id)}>
                    <td>
                      <a href={`/products/${String(p._id)}`}><strong>{String(p.name)}</strong></a>
                      <br />
                      <span className="muted"><code>{String(p.slug)}</code></span>
                    </td>
                    <td className="muted">{cfg.oneLiner || "—"}</td>
                    <td>{cfg.segments?.length ?? 0}</td>
                    <td><span className="pill">{String(p.status)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Add a product</h2>
      <form action={createProduct} className="stack">
        <label>Name<input name="name" placeholder="TeamGrid" required /></label>
        <label>Slug<input name="slug" placeholder="teamgrid" /></label>
        <label>Website<input name="website" type="url" placeholder="https://teamgrid.ai" /></label>
        <label>One-liner<input name="oneLiner" placeholder="Workforce intelligence for teams that bill by the hour" /></label>
        <label>Main value prop<input name="valueProp" placeholder="See where the week actually went, by client" /></label>
        <label>
          What counts as activated
          <input name="activation" placeholder="Two teammates tracked and one report opened" />
        </label>
        <button type="submit">Create product</button>
      </form>
    </main>
  );
}
