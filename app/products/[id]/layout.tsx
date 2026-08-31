import type { ReactNode } from "react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { ORG_ID, getProduct } from "../../tenant";

export const dynamic = "force-dynamic";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/connections", label: "Connections" },
  { href: "/channels", label: "Channels" },
  { href: "/sources", label: "Sources" },
  { href: "/goals", label: "Goals" },
  { href: "/templates", label: "Templates" },
  { href: "/leads", label: "Leads" },
  { href: "/claude", label: "Connect Claude" },
];

export default async function ProductLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) {
    return (
      <main>
        <h1>Product not found</h1>
        <p className="empty"><a href="/products">Back to products</a></p>
      </main>
    );
  }

  const db = await getDb();
  const products = await db.collection(C.products).find({ orgId: ORG_ID }).sort({ createdAt: 1 }).toArray();

  return (
    <>
      <nav className="top">
        <a className="brand" href="/products">Conversion Engine</a>
        <span className="muted">/</span>
        <div className="switcher">
          <strong>{String(product.name)}</strong>
          {products.length > 1 && (
            <div className="menu">
              {products.map((p) => (
                <a key={String(p._id)} href={`/products/${String(p._id)}`}>{String(p.name)}</a>
              ))}
            </div>
          )}
        </div>
      </nav>
      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t.href} href={`/products/${id}${t.href}`}>{t.label}</a>
        ))}
      </nav>
      {children}
    </>
  );
}
