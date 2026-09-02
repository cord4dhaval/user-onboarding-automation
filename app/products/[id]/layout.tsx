import type { ReactNode } from "react";
import { LogOut, Settings, Zap } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { getProduct, requireSession } from "../../tenant";
import { logOut } from "../../auth-actions";
import ThemeToggle from "../../theme";
import Notifications from "../../ui/notifications";
import { SubmitButton } from "../../ui/kit";
import { ToastProvider } from "../../ui/toast";
import Nav from "./nav";

export const dynamic = "force-dynamic";

export default async function ProductLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const product = await getProduct(id, session.orgId);

  if (!product) {
    return (
      <main className="page">
        <h1>Product not found</h1>
        <p className="sub">It may belong to another workspace, or it may have been deleted.</p>
        <p><a href="/products">Back to products</a></p>
      </main>
    );
  }

  const db = await getDb();
  const [products, review] = await Promise.all([
    db.collection(C.products).find({ orgId: session.orgId }).sort({ createdAt: 1 }).toArray(),
    db
      .collection(C.actions)
      .countDocuments({ orgId: session.orgId, productId: id, status: "awaiting_approval" }),
  ]);

  return (
    <ToastProvider>
    <div className="app">
      <aside className="side">
        <a className="brand" href="/products" style={{ padding: "4px 10px 14px", gap: 8 }}>
          <Zap size={17} strokeWidth={2.5} /> Engine
        </a>
        <Nav productId={id} counts={{ review }} />
        <div className="foot">
          <a href={`/products/${id}/settings`}>
            <Settings size={16} /> Settings
          </a>
        </div>
      </aside>

      <div>
        <header className="topbar">
          {products.length > 1 ? (
            <details className="switcher">
              <summary><strong>{String(product.name)}</strong> <span className="muted">▾</span></summary>
              <div>
                {products.map((p) => (
                  <a key={String(p._id)} href={`/products/${String(p._id)}`}>{String(p.name)}</a>
                ))}
              </div>
            </details>
          ) : (
            <strong>{String(product.name)}</strong>
          )}

          <span className="spacer" />
          <Notifications productId={id} />
          <ThemeToggle />
          <span className="muted" style={{ fontSize: 13 }}>{session.email}</span>
          <form action={logOut}>
            <SubmitButton variant="quiet" size="sm" icon={<LogOut />} aria-label="Sign out" />
          </form>
        </header>

        <main className="page">{children}</main>
      </div>
    </div>
    </ToastProvider>
  );
}
