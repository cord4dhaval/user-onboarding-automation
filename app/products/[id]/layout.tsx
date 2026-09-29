import type { ReactNode } from "react";
import { ChevronsUpDown, Zap } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { getAccount, getProduct, requireSession } from "../../tenant";
import AccountMenu from "../../ui/account-menu";
import Notifications from "../../ui/notifications";
import { ToastProvider } from "../../ui/toast";
import Nav from "./nav";
import { ideasLoopOn } from "@/engine/ideas.js";
import { repliesWaitingCount } from "@/engine/replies.js";

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
  const [account, products, review, replies] = await Promise.all([
    getAccount(session),
    db.collection(C.products).find({ orgId: session.orgId }).sort({ createdAt: 1 }).toArray(),
    db
      .collection(C.actions)
      .countDocuments({ orgId: session.orgId, productId: id, status: "awaiting_approval" }),
    repliesWaitingCount(session.orgId, id),
  ]);

  return (
    <ToastProvider>
    <div className="app">
      <aside className="side">
        <a className="brand" href="/products">
          <span className="logo"><Zap strokeWidth={2.5} /></span>
          <span>Engine</span>
        </a>

        {products.length > 1 ? (
          <details className="switcher">
            <summary className="prod">
              <span className="prod-mark" aria-hidden="true">{mark(String(product.name))}</span>
              <span>{String(product.name)}</span>
              <ChevronsUpDown />
            </summary>
            <div>
              {products.map((p) => (
                <a key={String(p._id)} href={`/products/${String(p._id)}`}>{String(p.name)}</a>
              ))}
            </div>
          </details>
        ) : (
          <div className="prod">
            <span className="prod-mark" aria-hidden="true">{mark(String(product.name))}</span>
            <span>{String(product.name)}</span>
          </div>
        )}

        <nav className="side-nav" aria-label="Product">
          <Nav productId={id} counts={{ review, replies }} />
        </nav>

        <div className="side-foot">
          {/* The ideas loop has a kill switch (IDEAS_LOOP=off); the server says whether it is on. */}
          <AccountMenu
            name={account.name}
            email={account.email}
            orgName={account.orgName}
            product={{ id, ideas: ideasLoopOn() }}
            showName
          />
          <Notifications productId={id} />
        </div>
      </aside>

      <div>
        <main className="page">{children}</main>
      </div>
    </div>
    </ToastProvider>
  );
}

/** Two letters for the product's square: "TeamGrid" → "TG", "Acme" → "AC". */
function mark(name: string): string {
  const caps = name.match(/[A-Z]/g) ?? [];
  if (caps.length >= 2) return `${caps[0]}${caps[1]}`;
  return name.trim().slice(0, 2).toUpperCase();
}
