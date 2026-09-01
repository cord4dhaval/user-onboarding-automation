import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { createProduct } from "../actions";
import { requireSession } from "../tenant";
import { logOut } from "../auth-actions";
import ThemeToggle from "../theme";

export const dynamic = "force-dynamic";

export default async function Products() {
  const { orgId, email } = await requireSession();
  const db = await getDb();
  const products = await db.collection(C.products).find({ orgId }).sort({ createdAt: 1 }).toArray();

  return (
    <div>
      <header className="topbar">
        <span className="brand">Engine</span>
        <span className="spacer" />
        <ThemeToggle />
        <span className="muted" style={{ fontSize: 13 }}>{email}</span>
        <form action={logOut}>
          <button className="quiet sm" type="submit">Sign out</button>
        </form>
      </header>

      <main className="page" style={{ maxWidth: 880, margin: "0 auto" }}>
        <h1>Products</h1>
        <p className="sub">
          A product is the container for everything else. Its config decides the segments, the templates and
          which channels are worth connecting — goals, leads and connections all live inside one.
        </p>

        {products.length === 0 ? (
          <div className="empty" style={{ marginBottom: 26 }}>
            <strong>No products yet</strong>
            Ask Claude to add one, so the config arrives complete — or fill it in by hand below.
          </div>
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
                        <div className="muted" style={{ fontSize: 12.5 }}><code>{String(p.slug)}</code></div>
                      </td>
                      <td className="muted">{cfg.oneLiner || "—"}</td>
                      <td className="num">{cfg.segments?.length ?? 0}</td>
                      <td><span className="pill ok">{String(p.status)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h2>Add a product</h2>
        <p className="sub" style={{ marginBottom: 16 }}>
          Claude writes a far better config than this form does — it reads the site and fills in segments,
          pains, objections and voice. This is the manual path.
        </p>
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
    </div>
  );
}
