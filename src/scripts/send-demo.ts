import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { fireDue } from "../engine/fireDue.js";
import { suppress } from "../engine/suppression.js";
import { resolveChannelAdapter } from "../engine/adapters.js";
import type { ChannelAdapter } from "../adapters/channel/types.js";

/**
 * Checkpoint 2: queued welcome touches are composed, validated, guardrailed and sent.
 *
 * Dry run by default — nothing reaches a provider. Pass --live with SMTP_* set in .env
 * to perform a real send.
 */

const ORG = "000000000000000000000001";
const PRODUCT = "000000000000000000000002";
const LIVE = process.argv.includes("--live");

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function main() {
  const db = await getDb();

  // The welcome template must render without a model, since it fires seconds after the
  // lead lands. Slots therefore carry deterministic fallback copy.
  await db.collection(C.templates).updateOne(
    { orgId: ORG, productId: PRODUCT, key: "welcome", scope: "product_default" },
    {
      $set: {
        blocks: [
          {
            type: "subject",
            slot: "warm one-line welcome naming their company, under 55 chars",
            fallback: "{{first_name}}, your TeamGrid workspace is ready",
          },
          { type: "text", fixed: "Hi {{first_name}}," },
          {
            type: "slot",
            instruct: "Two sentences on what they can do in the first ten minutes.",
            fallback:
              "Invite two teammates and TeamGrid starts mapping where your week actually goes — by project, by client, by person.\n\nMost teams see their first useful report inside a day.",
          },
          { type: "cta", fixed: "Open TeamGrid", url: "{{trial_link}}" },
          { type: "system", fixed: "opt_out_block" },
        ],
      },
    },
  );

  // Re-queue anything from an earlier run so the demo is repeatable.
  await db
    .collection(C.actions)
    .updateMany(
      { orgId: ORG, productId: PRODUCT, status: { $in: ["sent", "failed", "skipped", "sending", "awaiting_approval"] } },
      { $set: { status: "queued" }, $unset: { sentAt: "", providerMessageId: "" } },
    );
  await db.collection(C.channels).updateMany({ orgId: ORG }, { $set: { "governor.sentToday": 0 } });
  await db.collection(C.goalInstances).updateMany({ orgId: ORG }, { $set: { "spent.touches": 0 } });

  console.log("\n── guardrail check: suppress one lead ──");
  await suppress(ORG, "deepa@northbpo.com", "demo: manual suppression");
  line("suppressed", "deepa@northbpo.com");

  console.log("\n── compose, validate, send ──");
  line("mode", LIVE ? "LIVE — messages will actually be delivered" : "dry run — nothing leaves the machine");

  // Live sends go through the same resolver the engine uses, so what the demo exercises
  // is exactly what production runs.
  const adapterFor: ((channelId: string, key: string) => Promise<ChannelAdapter>) | undefined = LIVE
    ? async (channelId) => resolveChannelAdapter(ORG, channelId)
    : undefined;

  const summary = await fireDue({
    orgId: ORG,
    productId: PRODUCT,
    dryRun: !LIVE,
    adapterFor,
  });

  console.log("── result ──");
  line("claimed", String(summary.claimed));
  line("sent", String(summary.sent));
  line("held for approval", String(summary.heldForApproval));
  for (const b of summary.blocked) line("blocked", `${b.person} — ${b.reason}`);
  for (const f of summary.failed) line("failed", `${f.person} — ${f.error}`);

  console.log("\n── budget after send ──");
  const goals = await db.collection(C.goalInstances).find({ orgId: ORG, status: "active" }).toArray();
  for (const g of goals) {
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(g.personId)) });
    line(String(person?.name ?? g.personId), `${(g.spent as { touches: number }).touches}/9 touches spent`);
  }

  const channel = await db.collection(C.channels).findOne({ orgId: ORG, key: "email" });
  const gov = channel?.governor as { sentToday: number; dailyCap: number };
  line("channel usage", `${gov.sentToday}/${gov.dailyCap} sent today`);

  console.log("\n── second run (double-send check) ──");
  const again = await fireDue({ orgId: ORG, productId: PRODUCT, dryRun: true });
  line("claimed", String(again.claimed));
  console.log("  (should be 0 — nothing is queued any more)\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
