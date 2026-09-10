import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { verifyCampaign } from "./verify.js";

/**
 * A fact a page reports about a person: they reached the thank-you page, they booked.
 *
 * Shared by the public event endpoint, which a customer's own site calls, and by the
 * booking page, which is ours. Both end the same way: the event is written, and every
 * active campaign for the person is verified right away rather than on the next tick,
 * because someone who just did the thing the campaign was driving at must not receive
 * the next chase an hour later.
 *
 * A repeat inside a minute is dropped. A thank-you page refreshed four times is one
 * booking, and four events would read as a queue of them.
 */
const REPEAT_WINDOW_MS = 60_000;

export async function recordSiteEvent(personId: string, event: string, referer: string | null): Promise<boolean> {
  const name = event.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  if (!name || !ObjectId.isValid(personId)) return false;

  const db = await getDb();
  const person = await db
    .collection(C.people)
    .findOne({ _id: new ObjectId(personId) }, { projection: { orgId: 1, productId: 1 } });
  if (!person) return false;

  const orgId = String(person.orgId);
  const productId = String(person.productId);
  const type = `site_event:${name}`;
  const now = new Date();

  const recent = await db
    .collection(C.events)
    .findOne({ orgId, personId, type, ts: { $gte: new Date(now.getTime() - REPEAT_WINDOW_MS) } });
  if (recent) return true;

  await db.collection(C.events).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    personId,
    source: "product",
    type,
    payload: { event: name, referer },
    ts: now,
  });

  const active = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, personId, status: "active" })
    .project({ _id: 1 })
    .toArray();
  for (const instance of active) {
    try {
      await verifyCampaign(orgId, String(instance._id));
    } catch {
      // A verifier that cannot answer must never turn a recorded fact into a failure. The
      // event is written; the next tick will read it.
    }
  }
  return true;
}
