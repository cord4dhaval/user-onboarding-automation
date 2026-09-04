import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { notify } from "./notify.js";
import { suppress } from "./suppression.js";
import { tokenFor } from "./tracking.js";

/**
 * The way out.
 *
 * Every message we send carries an unsubscribe line, and until now that line pointed at the
 * product's marketing site — which has no access to this database and no idea what the id
 * in the URL refers to. Someone who clicked it saw a page, believed they were done, and
 * kept receiving mail. A door painted on a wall is worse than no door: it costs the reader
 * their only polite exit, and the next thing they reach for is the spam button.
 *
 * So this is deliberately model-free and campaign-free. No session, no judgement, no
 * routine has to run. A signed link arrives and the person is suppressed, in code, the same
 * way budgets and quiet hours are.
 */

export interface UnsubscribeResult {
  found: boolean;
  alreadyDone: boolean;
  email?: string;
}

/** The URL that goes in the mail. Signed, because it has to be trusted with no session. */
export function unsubscribeUrl(origin: string, personId: string): string {
  return `${origin.replace(/\/$/, "")}/api/u/${personId}?s=${tokenFor("u", personId)}`;
}

/**
 * Suppression is permanent and lands in three places: the block list every send and every
 * ingest checks, the person themselves so the library shows it, and their running campaigns,
 * which are ended rather than left to discover it later.
 *
 * Idempotent. A mail client that fetches the link twice, or a person who clicks it again
 * months later, must both get the same calm answer.
 */
export async function unsubscribePerson(personId: string, reason: string): Promise<UnsubscribeResult> {
  if (!ObjectId.isValid(personId)) return { found: false, alreadyDone: false };
  const db = await getDb();
  const _id = new ObjectId(personId);
  const person = await db
    .collection(C.people)
    .findOne({ _id }, { projection: { primaryEmail: 1, name: 1, orgId: 1, productId: 1, lifecycle: 1 } });
  if (!person) return { found: false, alreadyDone: false };

  const email = person.primaryEmail ? String(person.primaryEmail) : undefined;
  if (person.lifecycle === "suppressed") return { found: true, alreadyDone: true, email };

  const orgId = String(person.orgId);
  const now = new Date();
  if (email) await suppress(orgId, email, reason);

  await db.collection(C.people).updateOne(
    { _id },
    {
      $set: {
        lifecycle: "suppressed",
        suppressedAt: now,
        "consent.state": "withdrawn",
        "consent.capturedAt": now,
        "consent.evidence": reason,
      },
    },
  );

  // Ended, not merely paused. A campaign left active would keep its place in every sweep
  // and every report, and someone would eventually wonder why it never finishes.
  await db
    .collection(C.goalInstances)
    .updateMany(
      { orgId, personId, status: "active" },
      { $set: { status: "failed", outcome: "unsubscribed", endedAt: now } },
    );
  await db.collection(C.actions).updateMany(
    { orgId, personId, status: { $in: ["queued", "held", "awaiting_approval"] } },
    { $set: { status: "skipped", skipReason: "unsubscribed" } },
  );

  // The owner hears about it too. Someone leaving is not an emergency, but a campaign
  // quietly shedding people is — and that is only visible if each one is reported.
  await notify({
    orgId,
    productId: String(person.productId),
    severity: "good",
    dedupeKey: `engagement:unsubscribed:${personId}`,
    title: `${String(person.name ?? person.primaryEmail ?? email ?? "Someone")} unsubscribed`,
    body: `${reason}. They can never be contacted again from this product.`,
    href: `/products/${String(person.productId)}/library/${personId}`,
  });

  // Kept as an event so the person's own timeline says when they left and by what route.
  await db.collection(C.events).insertOne({
    orgId,
    productId: String(person.productId),
    personId,
    type: "unsubscribed",
    ts: now,
    payload: { reason },
  });

  return { found: true, alreadyDone: false, email };
}
