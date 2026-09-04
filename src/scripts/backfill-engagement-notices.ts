import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { notify } from "../engine/notify.js";

/**
 * Puts already-recorded engagement into the bell, once.
 *
 * Clicks, replies and opens are announced as they happen from now on. Everything that
 * arrived before that existed was written to the action and read by nothing, so a campaign
 * with nine clicks against it looked exactly like one with none. This walks the recent
 * record and raises the notice that should have been raised at the time.
 *
 * Safe to run twice: a person who already has a notice of that kind is skipped outright,
 * rather than having their count quietly doubled.
 *
 *   npx tsx --env-file=.env src/scripts/backfill-engagement-notices.ts [days]
 */
const DAYS = Number(process.argv[2] ?? 30);

async function main(): Promise<void> {
  const db = await getDb();
  const since = new Date(Date.now() - DAYS * 86_400_000);
  let raised = 0;
  let skipped = 0;

  const already = async (dedupeKey: string) =>
    (await db.collection(C.notifications).countDocuments({ dedupeKey }, { limit: 1 })) > 0;

  const person = async (id: string) =>
    ObjectId.isValid(id)
      ? db.collection(C.people).findOne({ _id: new ObjectId(id) }, { projection: { name: 1, primaryEmail: 1 } })
      : null;

  for (const type of ["clicked", "opened"] as const) {
    const field = type === "clicked" ? "firstClickedAt" : "firstOpenedAt";
    const actions = await db
      .collection(C.actions)
      .find(
        // Only what a person did to a message that actually went out. The raw field no
        // longer holds scanner fetches, and a link reached in an unsent draft is not a
        // reader either.
        { [field]: { $gte: since }, status: { $in: ["sent", "dispatched"] } },
        { projection: { orgId: 1, productId: 1, personId: 1, "content.subject": 1, [field]: 1 } },
      )
      .sort({ [field]: 1 })
      .toArray();

    for (const action of actions) {
      const personId = String(action.personId);
      const dedupeKey = `engagement:${type}:${personId}`;
      if (await already(dedupeKey)) {
        skipped++;
        continue;
      }
      const who = await person(personId);
      const name = String(who?.name ?? who?.primaryEmail ?? "Someone");
      const subject = (action.content as { subject?: string } | undefined)?.subject;

      await notify({
        orgId: String(action.orgId),
        productId: String(action.productId),
        severity: type === "clicked" ? "action" : "good",
        dedupeKey,
        title: type === "clicked" ? `${name} clicked a link` : `${name} opened your email`,
        body: [
          subject ? `"${subject}"` : null,
          type === "clicked"
            ? "Recorded before clicks were reported here."
            : "Opens are unreliable: some clients load images on their own.",
        ]
          .filter(Boolean)
          .join(" · "),
        href: `/products/${String(action.productId)}/library/${personId}`,
      });
      raised++;
    }
  }

  const replies = await db
    .collection(C.events)
    .find({ type: "reply_received", ts: { $gte: since } })
    .sort({ ts: 1 })
    .toArray();

  for (const event of replies) {
    const personId = String(event.personId);
    const dedupeKey = `engagement:replied:${personId}`;
    if (await already(dedupeKey)) {
      skipped++;
      continue;
    }
    const who = await person(personId);
    const payload = (event.payload ?? {}) as { text?: string };
    await notify({
      orgId: String(event.orgId),
      productId: String(event.productId),
      severity: "action",
      dedupeKey,
      title: `${String(who?.name ?? who?.primaryEmail ?? "Someone")} replied`,
      body: payload.text ? payload.text.slice(0, 160).replace(/\s+/g, " ").trim() : undefined,
      href: `/products/${String(event.productId)}/library/${personId}`,
    });
    raised++;
  }

  console.log(`${raised} notice${raised === 1 ? "" : "s"} raised, ${skipped} already present (last ${DAYS} days).`);
  process.exit(0);
}

void main();
