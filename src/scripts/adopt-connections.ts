import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Moves connections made before accounts existed into a real workspace.
 *
 * Only connections, their encrypted credentials and their discovered tool lists come
 * across. Everything else in the placeholder org is test data and is deliberately left
 * behind rather than dropped into someone's workspace.
 *
 *   npm run adopt -- admin@onboarding.ai
 */

const FROM_ORG = "000000000000000000000001";
const targetEmail = process.argv.find((a) => a.includes("@"));

async function main() {
  if (!targetEmail) throw new Error("Pass the account: npm run adopt -- you@example.com");
  const db = await getDb();

  const user = await db.collection(C.users).findOne({ email: targetEmail.toLowerCase() });
  if (!user) throw new Error(`no account for ${targetEmail}`);
  const membership = await db.collection(C.memberships).findOne({ userId: String(user._id) });
  if (!membership) throw new Error("that account has no workspace");
  const orgId = String(membership.orgId);

  const product = await db.collection(C.products).findOne({ orgId }, { sort: { createdAt: 1 } });
  if (!product) throw new Error("that workspace has no product to attach connections to");

  const connections = await db.collection(C.connections).find({ orgId: FROM_ORG }).toArray();
  if (connections.length === 0) {
    console.log("nothing to adopt");
    process.exit(0);
  }

  for (const connection of connections) {
    const connectionId = String(connection._id);
    // The credential travels unchanged — it is encrypted under a per-tenant data key that
    // is itself sealed with the master key, and the master key has not changed.
    await db
      .collection(C.credentials)
      .updateMany({ connectionId }, { $set: { orgId } });
    await db.collection(C.mcpBindings).updateMany({ connectionId }, { $set: { orgId } });
    await db
      .collection(C.connections)
      .updateOne({ _id: connection._id }, { $set: { orgId, productId: String(product._id) } });

    const binding = await db.collection(C.mcpBindings).findOne({ connectionId });
    const tools = (binding?.discoveredTools ?? []) as unknown[];
    console.log(`adopted ${String(connection.provider)} — ${tools.length} tools already discovered`);
  }

  console.log(`\nmoved into "${String(product.name)}" for ${targetEmail}`);
  console.log("next: open Connections, bind the tools, then create the channel\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
