import { LogOut } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { createProduct } from "../actions";
import { requireSession } from "../tenant";
import { logOut } from "../auth-actions";
import ThemeToggle from "../theme";
import { SubmitButton } from "../ui/kit";
import AddProduct from "./add-product";

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
        <span className="muted email">{email}</span>
        <form action={logOut}>
          <SubmitButton variant="quiet" size="sm" icon={<LogOut />}>
            Sign out
          </SubmitButton>
        </form>
      </header>

      <main className="page narrow">
        <header className="page-head">
          <div>
            <h1>Products</h1>
            <p className="sub">
              A product is the container for everything else. Its config decides the segments, the templates and
              which channels are worth connecting — campaigns, leads and connections all live inside one.
            </p>
          </div>
          <AddProduct action={createProduct} />
        </header>

        {products.length === 0 ? (
          <p className="empty">
            <strong>No products yet.</strong>
            Give Claude a URL and it writes the config, the brand kit, the templates and a set of draft
            campaigns. The manual form is there if you would rather type it.
          </p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>One-liner</th>
                  <th>Segments</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const cfg = p.config as { oneLiner?: string; segments?: unknown[] };
                  return (
                    <tr key={String(p._id)}>
                      <td>
                        <a href={`/products/${String(p._id)}`} className="strong-link">
                          {String(p.name)}
                        </a>
                        <span className="cell-sub">
                          <code>{String(p.slug)}</code>
                        </span>
                      </td>
                      <td className="muted">{cfg.oneLiner || "—"}</td>
                      <td className="num">{cfg.segments?.length ?? 0}</td>
                      <td>
                        <span className="pill ok">{String(p.status)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
