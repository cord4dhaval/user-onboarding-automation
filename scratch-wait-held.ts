import { getDb } from "./src/db/client.js";
import { COLLECTIONS as C } from "./src/db/collections.js";
const db = await getDb();
const held = await db.collection(C.actions).find({ status: "awaiting_approval" }).limit(3).toArray();
console.log("held:", held.length);
for (const a of held) {
  const c = (a.content ?? {}) as { subject?: string; bodyHtml?: string };
  console.log(" ", String(a._id), "|", c.subject ?? "—", "| html", c.bodyHtml ? c.bodyHtml.length + " chars" : "NONE");
}
process.exit(0);
