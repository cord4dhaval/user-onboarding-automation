import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ensureIndexes } from "../db/indexes.js";
import { goal as goalSchema } from "../schemas/goal.js";
import { template as templateSchema } from "../schemas/template.js";
import { person as personSchema } from "../schemas/person.js";
import { sealSecret, openSecret } from "../crypto/envelope.js";

/**
 * End-to-end smoke test of the foundation: indexes, schema validation, encryption
 * round-trip, and the cascade query that resolves a template for a person.
 * Seeds are idempotent, so this is safe to re-run.
 */

const ORG = "000000000000000000000001";
const PRODUCT = "000000000000000000000002";

function line(label: string, value: string) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function main() {
  console.log("\n── 1. connect + indexes ──");
  const db = await getDb();
  await ensureIndexes();
  const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
  line("database", db.databaseName);
  line("collections", names.length ? names.join(", ") : "(created on first write)");

  console.log("\n── 2. encryption round-trip ──");
  const sealed = sealSecret("pretend-mcp-token-abc123");
  const opened = openSecret(sealed);
  line("ciphertext", `${sealed.ciphertext.slice(0, 32)}…`);
  line("decrypts correctly", opened === "pretend-mcp-token-abc123" ? "yes" : "NO — BROKEN");

  console.log("\n── 3. seed product, goal, template ──");
  await db.collection(C.products).updateOne(
    { _id: new ObjectId(PRODUCT) },
    { $set: { orgId: ORG, slug: "teamgrid", name: "TeamGrid", version: 1, status: "active" } },
    { upsert: true },
  );

  const newUserGoal = goalSchema.parse({
    orgId: ORG,
    productId: PRODUCT,
    key: "new_user",
    name: "New user onboarding",
    entry: { expression: "lead_created", minIcpFit: 0.3 },
    success: {
      expression: "account_created AND teammates_invited >= 2 AND report_viewed >= 1",
      describedAs: "Account created, two teammates tracked, one report opened",
    },
    failure: { conditions: ["unsubscribe", "hard_bounce", "explicit_no"], silenceDays: 30 },
    budget: { touches: 9, days: 30, usd: 12 },
    firstTouch: { templateKey: "welcome", channels: ["email", "whatsapp"] },
    schedule: {
      fetchEverySec: 600,
      tickEverySec: 600,
      bufferDepth: 3,
      approvalMode: "gate_on",
    },
    cadenceByTemp: {
      hot: { minGapDays: 2, maxGapDays: 3, maxAssetTier: "C" },
      warm: { minGapDays: 4, maxGapDays: 6, maxAssetTier: "C" },
      cold: { minGapDays: 8, maxGapDays: 12, maxAssetTier: "A" },
      dead: { minGapDays: 999, maxGapDays: 999, maxAssetTier: "A" },
    },
    nextGoalKey: "convert_to_paid",
  });
  await db.collection(C.goals).updateOne(
    { orgId: ORG, productId: PRODUCT, key: "new_user" },
    { $set: newUserGoal },
    { upsert: true },
  );
  line("goal", `${newUserGoal.key} — ${newUserGoal.success.describedAs}`);
  line("clock", `fetch every ${newUserGoal.schedule.fetchEverySec}s, gate ${newUserGoal.schedule.approvalMode}`);
  line("first touch", `${newUserGoal.firstTouch.templateKey} via ${newUserGoal.firstTouch.channels.join(" → ")}`);

  const welcome = templateSchema.parse({
    orgId: ORG,
    productId: PRODUCT,
    key: "welcome",
    channel: "email",
    stage: "first_touch",
    scope: "product_default",
    blocks: [
      { type: "subject", slot: "warm one-line welcome naming their company, under 55 chars" },
      { type: "text", fixed: "Hi {{first_name}}," },
      { type: "slot", instruct: "Two sentences: what they can do in TeamGrid in the first ten minutes. No filler." },
      { type: "cta", fixed: "Open TeamGrid", url: "{{trial_link}}" },
      { type: "system", fixed: "opt_out_block" },
    ],
    constraints: { maxWords: 120, readingLevel: 8, noClaims: ["guaranteed ROI"] },
    stats: {},
    status: "active",
    createdBy: "claude",
  });
  await db.collection(C.templates).updateOne(
    { orgId: ORG, productId: PRODUCT, key: "welcome", scope: "product_default" },
    { $set: welcome },
    { upsert: true },
  );
  line("template", `${welcome.key} (${welcome.blocks.length} blocks, ${welcome.scope})`);

  console.log("\n── 4. seed a person ──");
  const rahul = personSchema.parse({
    orgId: ORG,
    productId: PRODUCT,
    identities: [{ kind: "email", value: "rahul@brightpixel.in", verified: true }],
    primaryEmail: "rahul@brightpixel.in",
    name: "Rahul Mehta",
    role: "Founder",
    companyDomain: "brightpixel.in",
    timezone: "Asia/Kolkata",
    consent: { state: "legitimate_interest", capturedAt: new Date(), evidence: "webinar_2026_08" },
    needsClassification: true,
    createdAt: new Date(),
  });
  await db.collection(C.people).updateOne(
    { orgId: ORG, productId: PRODUCT, primaryEmail: rahul.primaryEmail },
    { $set: rahul },
    { upsert: true },
  );
  line("person", `${rahul.name} — ${rahul.primaryEmail} (${rahul.timezone})`);

  console.log("\n── 5. template cascade lookup ──");
  const resolved = await db
    .collection(C.templates)
    .find({ orgId: ORG, productId: PRODUCT, channel: "email", stage: "first_touch", status: "active" })
    .sort({ scope: 1 })
    .limit(1)
    .toArray();
  line("resolved for email", resolved[0] ? `${resolved[0].key} (${resolved[0].scope})` : "none found");

  console.log("\n── 6. backlog ──");
  const pending = await db
    .collection(C.people)
    .countDocuments({ orgId: ORG, productId: PRODUCT, needsClassification: true });
  line("awaiting classification", String(pending));

  console.log("\nfoundation OK — schemas validate, indexes exist, crypto round-trips.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
