import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ensureIndexes } from "../db/indexes.js";
import { fireDue } from "../engine/fireDue.js";
import { reconcileDispatched } from "../engine/reconcile.js";
import { resolveChannelAdapter } from "../engine/adapters.js";

/**
 * End-to-end live test: creates one lead, opens its goal, queues the welcome touch,
 * sends it for real through the configured channel, then polls until the provider
 * confirms delivery.
 *
 *   npm run test:live -- you@example.com
 */

const ORG = "000000000000000000000001";
const PRODUCT = "000000000000000000000002";

const target = process.argv.find((a) => a.includes("@"));
const line = (label: string, value: string) => console.log(`  ${label.padEnd(24)} ${value}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!target) throw new Error("Pass a test address: npm run test:live -- you@example.com");
  const db = await getDb();
  await ensureIndexes();

  console.log("\n── preflight ──");
  const channel = await db
    .collection(C.channels)
    .findOne({ orgId: ORG, productId: PRODUCT, key: "email", enabled: true, status: "healthy" });
  if (!channel) throw new Error("No healthy email channel. Create one on the Channels page first.");

  const caps = channel.capabilities as Record<string, unknown>;
  const gov = channel.governor as { dailyCap: number; perMinute?: number; perHour?: number };
  line("channel", `${String(channel.key)} · ${String(channel.kind)}`);
  line("limits", `${gov.perMinute ?? "—"}/min · ${gov.perHour ?? "—"}/hr · ${gov.dailyCap}/day`);
  line("delivery", caps.asyncDelivery ? "queued, needs reconciliation" : "synchronous");

  // Fails loudly here rather than at send time, when a touch would already be spent.
  await resolveChannelAdapter(ORG, String(channel._id));
  line("adapter", "resolved OK");

  const goal = await db.collection(C.goals).findOne({ orgId: ORG, productId: PRODUCT, key: "new_user" });
  if (!goal) throw new Error('Goal "new_user" not found.');

  const template = await db.collection(C.templates).findOne({
    orgId: ORG,
    productId: PRODUCT,
    key: (goal.firstTouch as { templateKey: string }).templateKey,
    channel: "email",
    scope: "product_default",
    status: "active",
  });
  if (!template) throw new Error("No active welcome template for email.");
  line("template", String(template.key));

  console.log("\n── seed the test lead ──");
  const email = target.toLowerCase();
  await db.collection(C.suppressions).deleteMany({ orgId: ORG, identityValue: email });
  await db.collection(C.people).deleteMany({ orgId: ORG, productId: PRODUCT, primaryEmail: email });

  const personId = new ObjectId();
  await db.collection(C.people).insertOne({
    _id: personId,
    orgId: ORG,
    productId: PRODUCT,
    identities: [{ kind: "email", value: email, verified: true }],
    primaryEmail: email,
    name: "Test Lead",
    companyDomain: email.split("@")[1],
    timezone: "Asia/Kolkata",
    language: "en",
    stage: "lead",
    consent: { state: "opt_in", capturedAt: new Date(), evidence: "live test" },
    needsClassification: true,
    createdAt: new Date(),
  });

  const goalInstanceId = new ObjectId();
  const budget = goal.budget as { touches: number; days: number };
  await db.collection(C.goalInstances).insertOne({
    _id: goalInstanceId,
    orgId: ORG,
    productId: PRODUCT,
    personId: String(personId),
    goalKey: "new_user",
    status: "active",
    spent: { touches: 0, usd: 0 },
    deadline: new Date(Date.now() + budget.days * 86_400_000),
    nextTickAt: new Date(),
    startedAt: new Date(),
  });

  const actionId = new ObjectId();
  await db.collection(C.actions).insertOne({
    _id: actionId,
    orgId: ORG,
    productId: PRODUCT,
    goalInstanceId: String(goalInstanceId),
    personId: String(personId),
    channel: "email",
    channelId: String(channel._id),
    templateId: String(template._id),
    angle: "welcome",
    rationale: "live delivery test",
    idempotencyKey: `livetest:${String(actionId)}`,
    status: "queued",
    dueAt: new Date(),
    cost: 0,
    signals: [],
    next: {},
    content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
    assetIds: [],
  });
  line("lead", email);
  line("queued", "1 welcome touch");

  console.log("\n── send for real ──");
  const summary = await fireDue({
    orgId: ORG,
    productId: PRODUCT,
    dryRun: false,
    // The approval gate is bypassed deliberately: this script exists to prove delivery.
    adapterFor: (channelId) => resolveChannelAdapter(ORG, channelId),
  });
  line("claimed", String(summary.claimed));
  line("sent", String(summary.sent));
  line("queued remotely", String(summary.queuedRemotely));
  line("deferred", String(summary.deferred));
  for (const b of summary.blocked) line("blocked", `${b.person} — ${b.reason}`);
  for (const f of summary.failed) line("failed", `${f.person} — ${f.error}`);

  const after = await db.collection(C.actions).findOne({ _id: actionId });
  line("status", String(after?.status));
  if (after?.providerMessageId) line("provider id", String(after.providerMessageId));

  if (after?.status === "dispatched") {
    console.log("\n── reconcile (provider queues, so poll for the real outcome) ──");
    for (let attempt = 1; attempt <= 10; attempt++) {
      await sleep(6000);
      const r = await reconcileDispatched(ORG, PRODUCT);
      const now = await db.collection(C.actions).findOne({ _id: actionId });
      line(`attempt ${attempt}`, `${String(now?.status)} (confirmed ${r.confirmed}, failed ${r.failed})`);
      if (now?.status === "sent" || now?.status === "failed") break;
    }
  }

  const final = await db.collection(C.actions).findOne({ _id: actionId });
  console.log("\n── result ──");
  line("final status", String(final?.status));
  line("subject", String((final?.content as { subject?: string })?.subject ?? "—"));
  console.log(
    final?.status === "sent"
      ? `\nDelivered. Check ${email}.\n`
      : `\nNot confirmed as delivered — status is "${String(final?.status)}".\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
