import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

export interface FormLeadsSummary {
  people: number;
  arrivalsTagged: number;
  consentUpgraded: number;
}

/**
 * Marks a source as bringing form leads, or stops, and brings the people it already
 * brought in into line.
 *
 * Somebody who filled in a form asking about the product gave their address to hear from
 * us: they are opted in, which is what allows the open pixel, and they start warm rather
 * than being judged on a company-fit guess. The flag on the source decides that for every
 * future arrival; this also applies it to the people who arrived before it was set.
 *
 * Turning it off changes what future arrivals mean, not what past ones were. Nobody's
 * consent is downgraded, and a person who withdrew is never upgraded.
 */
export async function setFormLeads(
  orgId: string,
  productId: string,
  sourceId: string,
  on: boolean,
): Promise<FormLeadsSummary> {
  const db = await getDb();
  const result = await db
    .collection(C.sources)
    .updateOne({ _id: new ObjectId(sourceId), orgId, productId }, { $set: { formLeads: on } });
  if (result.matchedCount === 0) throw new Error("source not found");

  const summary: FormLeadsSummary = { people: 0, arrivalsTagged: 0, consentUpgraded: 0 };
  if (!on) return summary;

  const filter = { orgId, productId, "arrivals.sourceId": sourceId };
  summary.people = await db.collection(C.people).countDocuments(filter);

  const tagged = await db
    .collection(C.people)
    .updateMany(filter, { $set: { "arrivals.$[a].intent": "form" } }, { arrayFilters: [{ "a.sourceId": sourceId }] });
  summary.arrivalsTagged = tagged.modifiedCount;

  const upgraded = await db.collection(C.people).updateMany(
    { ...filter, "consent.state": "legitimate_interest" },
    { $set: { "consent.state": "opt_in", "consent.evidence": `form:${sourceId}`, "consent.upgradedAt": new Date() } },
  );
  summary.consentUpgraded = upgraded.modifiedCount;

  // Temperature is re-read oldest first. Putting these people at the front means the next
  // tick warms them, instead of whichever tick reaches them in turn.
  await db
    .collection(C.people)
    .updateMany({ ...filter, temp: { $exists: true } }, { $set: { "temp.computedAt": new Date(0) } });

  return summary;
}
