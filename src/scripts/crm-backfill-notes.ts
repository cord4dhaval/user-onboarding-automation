import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { noteEvent, noteOpenedToday, pageName, sentNote, shorten } from "../engine/crm/writeBack.js";

/**
 * Writes the last few days of our activity into the sales CRM, once, for leads it already
 * knows.
 *
 * Writing back starts the day it is switched on, and a lead page that begins mid-story is
 * worse than one that begins at the beginning: a rep sees "Opened our email today" under a
 * lead nobody appears to have written to. So the days either side of the switch are filled
 * in from what actually happened.
 *
 * Everything goes through the same queue and the same keys as a live event, so a backfilled
 * note and a live one can never both be written for the same thing — the queue refuses the
 * second. Nothing here writes to the CRM itself; the CRM's own run does that, a call every
 * three seconds.
 *
 * `--new-only` narrows it to the people who arrived inside the same window, which is the
 * gentler way in: their lead in the CRM is new too, so their page starts at the beginning
 * rather than acquiring a history halfway through.
 *
 *   npx tsx --env-file=.env src/scripts/crm-backfill-notes.ts --product <id> [--days 2] [--new-only] [--dry]
 */

const arg = (name: string, fallback?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : fallback;
};

const productId = arg("product") ?? "";
const days = Number(arg("days", "2"));
const dry = process.argv.includes("--dry");
const newOnly = process.argv.includes("--new-only");
if (!productId) throw new Error("--product <productId> is required");

const db = await getDb();
const product = await db.collection(C.products).findOne({ _id: (await import("mongodb")).ObjectId.createFromHexString(productId) });
if (!product) throw new Error("product not found");
const orgId = String(product.orgId);
const since = new Date(Date.now() - days * 86_400_000);

// Only campaigns that were asked to write. The switch on the connection is checked by
// noteEvent itself, so a dry run before it is turned on still shows what would be written.
const campaigns = await db.collection(C.goals).find({ orgId, productId, crmWrite: true }).project({ key: 1 }).toArray();
const keys = campaigns.map((g) => String(g.key));
const instances = await db
  .collection(C.goalInstances)
  .find({ orgId, productId, goalKey: { $in: keys } })
  .project({ _id: 1, goalKey: 1, personId: 1 })
  .toArray();
const campaignOf = new Map(instances.map((i) => [String(i._id), String(i.goalKey)]));

console.log(`product ${productId} · campaigns that write: ${keys.join(", ") || "none"} · since ${since.toISOString().slice(0, 16)}`);

const actions = await db
  .collection(C.actions)
  .find({
    orgId,
    productId,
    goalInstanceId: { $in: [...campaignOf.keys()] },
    $or: [
      { status: "sent", sentAt: { $gte: since } },
      { firstOpenedAt: { $gte: since } },
      { firstClickedAt: { $gte: since } },
    ],
  })
  .toArray();

/** Every note this backfill would write, in the order the things happened. */
const planned: Array<{ at: Date; personId: string; campaignKey: string; body: string; run: () => Promise<boolean> }> = [];

for (const action of actions) {
  const campaignKey = campaignOf.get(String(action.goalInstanceId)) ?? "";
  const personId = String(action.personId);
  const base = { orgId, productId, personId, campaignKey };
  const content = (action.content ?? {}) as { subject?: string; slotText?: string; bodyMd?: string };

  if (action.status === "sent" && action.sentAt && new Date(action.sentAt) >= since) {
    const note = sentNote({
      channel: String(action.channel),
      op: action.op ? String(action.op) : undefined,
      subject: content.subject,
      text: content.slotText || content.bodyMd,
    });
    if (note) {
      planned.push({
        at: new Date(action.sentAt),
        personId,
        campaignKey,
        body: note.body,
        run: () => noteEvent({ ...base, event: note.event, body: note.body, key: String(action._id) }),
      });
    }
  }

  if (action.firstClickedAt && new Date(action.firstClickedAt) >= since) {
    const url = ((action.signals ?? []) as Array<{ type?: string; url?: string }>).find((s) => s.type === "clicked")?.url;
    const body = `Link clicked — ${pageName(url)} — from "${shorten(content.subject)}"`;
    planned.push({
      at: new Date(action.firstClickedAt),
      personId,
      campaignKey,
      body,
      run: () => noteEvent({ ...base, event: "clicked", body, key: String(action._id) }),
    });
  }
}

// Opens are one line per person per day, exactly as they are live, so the earliest open of
// each day is the one that speaks for it.
const openDays = new Map<string, { at: Date; personId: string; campaignKey: string }>();
for (const action of actions) {
  if (!action.firstOpenedAt || new Date(action.firstOpenedAt) < since) continue;
  const at = new Date(action.firstOpenedAt);
  const personId = String(action.personId);
  const key = `${personId}:${at.toISOString().slice(0, 10)}`;
  const seen = openDays.get(key);
  if (!seen || at < seen.at) openDays.set(key, { at, personId, campaignKey: campaignOf.get(String(action.goalInstanceId)) ?? "" });
}
for (const [key, open] of openDays) {
  planned.push({
    at: open.at,
    personId: open.personId,
    campaignKey: open.campaignKey,
    body: "Opened our email today",
    run: () =>
      noteEvent({
        orgId,
        productId,
        personId: open.personId,
        campaignKey: open.campaignKey,
        event: "opened",
        body: "Opened our email today",
        key,
      }),
  });
}

// Only what belongs to somebody who arrived in this window, when asked for.
let writing = planned;
if (newOnly) {
  const arrived = await db
    .collection(C.people)
    .find({ orgId, productId, $or: [{ createdAt: { $gte: since } }, { "arrivals.at": { $gte: since } }] })
    .project({ _id: 1 })
    .toArray();
  const fresh = new Set(arrived.map((p) => String(p._id)));
  writing = planned.filter((n) => fresh.has(n.personId));
  console.log(`--new-only: ${fresh.size} people arrived in this window, ${writing.length} of ${planned.length} notes are theirs`);
}

const planned2 = writing;
planned2.sort((a, b) => a.at.getTime() - b.at.getTime());
console.log(`${planned2.length} notes to write\n`);
for (const note of planned2.slice(0, 200)) {
  console.log(`  ${note.at.toISOString().slice(0, 16)} ${note.campaignKey.padEnd(24)} ${note.body}`);
}

if (dry) {
  console.log("\n--dry: nothing queued.");
  process.exit(0);
}

let queued = 0;
let refused = 0;
for (const note of planned2) ((await note.run()) ? queued++ : refused++);
console.log(`\nqueued ${queued} · refused ${refused} (writing off, campaign not writing, or the lead is not in their CRM)`);

// Today's open line is now accounted for, so a live open later today does not write a second
// one. noteOpenedToday claims the day on the person; this claims it the same way.
const today = new Date().toISOString().slice(0, 10);
for (const [key, open] of openDays) {
  if (!key.endsWith(today)) continue;
  await noteOpenedToday({ orgId, productId, personId: open.personId, now: new Date() }).catch(() => false);
}
process.exit(0);
