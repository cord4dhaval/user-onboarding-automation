import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { getProduct, requireSession } from "../../../tenant";
import { saveProductConfig } from "../../../actions";
import { Save } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";

export const dynamic = "force-dynamic";

export default async function Settings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const product = await getProduct(id, session.orgId);
  if (!product) return null;

  const db = await getDb();
  const org = await db.collection(C.organizations).findOne({ orgId: session.orgId } as never);

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Appearance is in the top bar and remembered on this device.</p>

      <h2>Account</h2>
      <div className="tw">
        <table>
          <tbody>
            <tr><th style={{ width: 140 }}>Signed in as</th><td>{session.email}</td></tr>
            <tr><th>Workspace</th><td>{String(org?.name ?? "—")}</td></tr>
            <tr><th>Product</th><td>{String(product.name)} · <code>{String(product.slug)}</code></td></tr>
          </tbody>
        </table>
      </div>

      <h2>Product config</h2>
      <p className="sub">
        The whole product-specific surface: segments, activation, voice, constraints and suggested channels.
        Everything else in the engine is generic.
      </p>
      <form action={saveProductConfig} className="stack" style={{ maxWidth: "100%" }}>
        <input type="hidden" name="productId" value={id} />
        <textarea name="config" defaultValue={JSON.stringify(product.config, null, 2)} style={{ minHeight: 380 }} />
        <SubmitButton icon={<Save />} pendingLabel="Saving…">Save config</SubmitButton>
      </form>

      <h2>Safety</h2>
      <div className="note bad">
        <p><strong>Global pause is not built yet.</strong> One switch that stops every send everywhere belongs
        in the sidebar, reachable from any screen. Until it exists, pause each goal individually or disable the
        channel.</p>
      </div>
    </>
  );
}
