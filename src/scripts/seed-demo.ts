import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ensureIndexes } from "../db/indexes.js";
import { createAccount } from "../auth/accounts.js";
import { productConfig } from "../schemas/product.js";
import { generateDefaultTemplates } from "../engine/templates.js";

/**
 * Creates a demo account with TeamGrid already configured, so a fresh database has
 * something to look at. Safe to re-run — an existing account is reused.
 */

const EMAIL = process.env.DEMO_EMAIL ?? "admin@onboarding.ai";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Team12345";

const config = productConfig.parse({
  website: "https://teamgrid.ai",
  oneLiner: "Workforce intelligence — see where the week actually went, by project, client and person.",
  valueProps: [
    "See where the week actually went, by client and by project",
    "Spot the retainer that is eating more hours than it bills",
  ],
  segments: [
    {
      key: "agency_owner",
      name: "Agency owner",
      detect: "services or agency site, retainer language, 10-60 people",
      useCase: "billable hours and per-client profitability",
      pain: "finding out a retainer was unprofitable only at renewal",
      objections: ["the team will feel surveilled", "setup will take a week"],
      preferredChannels: ["email"],
    },
    {
      key: "eng_leader",
      name: "Engineering leader",
      detect: "product or dev-shop site, VP or Head of Engineering",
      useCase: "capacity visibility across squads",
      pain: "no honest read on where engineering time goes",
      objections: ["this is micromanagement"],
      preferredChannels: ["email"],
    },
  ],
  activation: {
    describedAs: "Two teammates tracked for three days and one report opened",
    events: ["account_created", "teammate_invited", "session_recorded", "report_viewed"],
  },
  voice: {
    tone: "direct and specific, no hype, no exclamation marks",
    do: ["lead with their situation", "one idea per message"],
    dont: ["say revolutionary", "open with 'I hope this email finds you well'"],
    readingLevel: 8,
  },
  constraints: { maxTouchesPerWeek: 2, quietHours: [21, 8], forbiddenClaims: ["guaranteed ROI"] },
  suggestedChannels: [
    { key: "email", why: "Every lead has one, and it carries enough room to make a case.", priority: 1 },
    { key: "in_app", why: "Free, no deliverability risk, best place to nudge a live trial.", priority: 2 },
  ],
  trialLinkTemplate: "https://teamgrid.ai/start?p={{person_id}}",
});

async function main() {
  const db = await getDb();
  await ensureIndexes();

  let orgId: string;
  const existing = await db.collection(C.users).findOne({ email: EMAIL });
  if (existing) {
    const membership = await db.collection(C.memberships).findOne({ userId: String(existing._id) });
    orgId = String(membership?.orgId);
    console.log(`demo user already exists — ${EMAIL}`);
  } else {
    const account = await createAccount({
      email: EMAIL,
      password: PASSWORD,
      name: "Demo",
      orgName: "Onboarding",
    });
    orgId = account.orgId;
    console.log(`demo user created — ${EMAIL} / ${PASSWORD}`);
  }

  const existingProduct = await db.collection(C.products).findOne({ orgId, slug: "teamgrid" });
  const productId = existingProduct?._id ?? new ObjectId();
  await db.collection(C.products).updateOne(
    { _id: productId },
    {
      $set: { orgId, slug: "teamgrid", name: "TeamGrid", config, status: "active" },
      $setOnInsert: { version: 1, createdAt: new Date() },
    },
    { upsert: true },
  );

  const templates = await generateDefaultTemplates(orgId, String(productId), config);

  await db.collection(C.goals).updateOne(
    { orgId, productId: String(productId), key: "new_user" },
    {
      $set: {
        orgId,
        productId: String(productId),
        key: "new_user",
        name: "New user onboarding",
        entry: { expression: "lead_created", minIcpFit: 0 },
        success: {
          expression: "account_created AND teammates_invited >= 2 AND report_viewed >= 1",
          describedAs: "Account created, two teammates tracked, one report opened",
        },
        failure: { conditions: ["unsubscribe", "hard_bounce", "explicit_no"], silenceDays: 30 },
        budget: { touches: 9, days: 30, usd: 12 },
        firstTouch: { templateKey: "welcome", channels: ["email"] },
        schedule: { fetchEverySec: 600, tickEverySec: 600, bufferDepth: 3, approvalMode: "gate_on" },
        cadenceByTemp: {
          hot: { minGapDays: 2, maxGapDays: 3, maxAssetTier: "C" },
          warm: { minGapDays: 4, maxGapDays: 6, maxAssetTier: "C" },
          cold: { minGapDays: 8, maxGapDays: 12, maxAssetTier: "A" },
          dead: { minGapDays: 999, maxGapDays: 999, maxAssetTier: "A" },
        },
        sourceIds: [],
        enabled: true,
      },
    },
    { upsert: true },
  );

  console.log(`product TeamGrid ready — ${templates} templates, goal new_user`);
  console.log(`\nsign in at /login with ${EMAIL} / ${PASSWORD}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
