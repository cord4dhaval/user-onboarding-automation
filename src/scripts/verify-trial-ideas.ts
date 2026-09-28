import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { TRIAL_LEADS, TRIAL_MIN_SENDS, TRIAL_WATCH_HOURS, inventedOf, reviewInventedIdeas, trialReach } from "../engine/ideas.js";

/**
 * Where every trial idea stands, and what a review would do with it.
 *
 * The loop stalled once before, silently: trial ideas were blocked from new leads by a count
 * of plans while their graduation waited on a count of sends, and the two can never meet once
 * a step is skipped (see trialReach). This prints both counts per idea, so the stall is a line
 * on a screen rather than something noticed weeks later in a refusal log.
 *
 *   npm run verify:ideas -- <productId>          what each trial would do
 *   npm run verify:ideas -- <productId> --move   and then actually move them
 */
async function main(): Promise<void> {
  const productId = process.argv[2];
  const move = process.argv.includes("--move");
  if (!productId || !ObjectId.isValid(productId)) throw new Error("Pass a productId: npm run verify:ideas -- <productId> [--move]");

  const db = await getDb();
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) }, { projection: { orgId: 1, name: 1, "config.writing.invented": 1 } });
  if (!product) throw new Error(`No product ${productId}`);
  const orgId = String(product.orgId);
  const invented = inventedOf(product);
  console.log(`${String(product.name)}: ${invented.length} invented ideas (${invented.filter((i) => i.status === "trial").length} on trial of ${TRIAL_LEADS} leads each)\n`);

  for (const idea of invented) {
    const written = await db
      .collection(C.actions)
      .find({ orgId, productId, ideaRefs: idea.n, dryRun: { $ne: true } }, { projection: { status: 1, sentAt: 1, firstClickedAt: 1, firstRepliedAt: 1 } })
      .toArray();
    const sent = written.filter((a) => ["sent", "dispatched"].includes(String(a.status)));
    const coming = written.filter((a) => ["queued", "held", "awaiting_approval", "sending"].includes(String(a.status))).length;
    const dead = written.length - sent.length - coming;
    const last = Math.max(0, ...sent.map((a) => new Date(String(a.sentAt)).getTime()).filter((t) => Number.isFinite(t)));
    const hours = last ? Math.round((Date.now() - last) / 3_600_000) : 0;
    const watched = last > 0 && Date.now() - last >= TRIAL_WATCH_HOURS * 3_600_000;
    const responses = sent.filter((a) => a.firstClickedAt || a.firstRepliedAt).length;
    const reach = await trialReach({ orgId, productId, n: idea.n });
    const heardEnough = sent.length >= TRIAL_LEADS || (coming === 0 && sent.length >= TRIAL_MIN_SENDS && watched);
    const next =
      idea.status !== "trial"
        ? idea.status
        : heardEnough
          ? "judge now"
          : reach < TRIAL_LEADS
            ? "open for more leads"
            : coming > 0
              ? `waits: ${coming} mail(s) still to go`
              : sent.length < TRIAL_MIN_SENDS
                ? `waits: ${TRIAL_MIN_SENDS} sends needed to judge it`
                : `waits: watching until ${TRIAL_WATCH_HOURS}h after the last send`;
    console.log(
      `#${idea.n} ${idea.status.padEnd(7)} sent ${sent.length} · waiting ${coming} · never sent ${dead} · reach ${reach}/${TRIAL_LEADS} · ` +
        `${responses} clicked or replied · last send ${hours}h ago -> ${next}`,
    );
  }

  if (!move) {
    console.log("\nNothing written. Add --move to let what_works move them.");
    return;
  }
  const moves = await reviewInventedIdeas(orgId, productId);
  console.log(`\n${moves.length} moved:`);
  for (const m of moves) console.log(`  #${m.n} ${m.from} -> ${m.to}: ${m.reason}`);
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
