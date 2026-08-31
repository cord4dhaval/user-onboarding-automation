import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { productConfig } from "../schemas/product.js";
import { generateDefaultTemplates } from "../engine/templates.js";

/**
 * Seeds TeamGrid as the first product. Segments and voice here are a starting draft
 * inferred from the public site — replace them on the product page once the real
 * positioning is confirmed. Everything downstream keys off this document.
 */

const ORG = "000000000000000000000001";
const PRODUCT = new ObjectId("000000000000000000000002");

const config = productConfig.parse({
  website: "https://teamgrid.ai",
  oneLiner: "Workforce intelligence — see where the week actually went, by project, client and person.",
  valueProps: [
    "See where the week actually went, by client and by project",
    "Spot the retainer that is eating more hours than it bills",
    "Attendance and activity reporting without chasing timesheets",
  ],
  segments: [
    {
      key: "agency_owner",
      name: "Agency owner",
      detect: "services or agency site, retainer or client-project language, 10-60 people",
      useCase: "billable hours and per-client profitability",
      pain: "finding out a retainer was unprofitable only at renewal",
      objections: ["the team will feel surveilled", "setup will take a week"],
      preferredChannels: ["email", "linkedin"],
    },
    {
      key: "eng_leader",
      name: "Engineering leader",
      detect: "product or dev-shop site, VP/Director/Head of Engineering title",
      useCase: "capacity visibility across squads",
      pain: "no honest read on where engineering time goes",
      objections: ["this is micromanagement", "another dashboard nobody opens"],
      preferredChannels: ["email"],
    },
    {
      key: "remote_founder",
      name: "Remote-first founder",
      detect: "distributed team signals, under 20 people, founder or CEO title",
      useCase: "visibility into a team nobody sits next to",
      pain: "cannot tell whether a distributed team is actually moving",
      objections: ["overkill for our size", "we trust our people"],
      preferredChannels: ["email"],
    },
    {
      key: "hr_compliance",
      name: "HR and compliance",
      detect: "BPO, staffing or enterprise HR, 100+ people, HR or Ops title",
      useCase: "attendance records and audit-ready reporting",
      pain: "assembling attendance evidence by hand every quarter",
      objections: ["works council or privacy pushback", "integration with payroll"],
      preferredChannels: ["email"],
    },
  ],
  activation: {
    describedAs: "Two teammates tracked for three days and one report opened",
    events: ["account_created", "teammate_invited", "session_recorded", "report_viewed"],
  },
  voice: {
    tone: "direct and specific, no hype, no exclamation marks",
    do: ["lead with their situation", "use their real numbers where available", "one idea per message"],
    dont: ["say revolutionary or game-changing", "open with 'I hope this email finds you well'"],
    readingLevel: 8,
  },
  constraints: {
    maxTouchesPerWeek: 2,
    quietHours: [21, 8],
    forbiddenClaims: ["guaranteed ROI", "10x productivity"],
  },
  suggestedChannels: [
    { key: "email", why: "Every lead has one, and it carries enough room to make a case.", priority: 1 },
    { key: "in_app", why: "Free, no deliverability risk, and the best place to nudge an existing trial.", priority: 2 },
    { key: "whatsapp", why: "Normal for B2B in the Indian market, but consent-gated.", priority: 3 },
  ],
  trialLinkTemplate: "https://teamgrid.ai/start?p={{person_id}}",
});

async function main() {
  const db = await getDb();
  await db.collection(C.products).updateOne(
    { _id: PRODUCT },
    { $set: { orgId: ORG, slug: "teamgrid", name: "TeamGrid", config, status: "active" },
      $setOnInsert: { version: 1, createdAt: new Date() } },
    { upsert: true },
  );
  console.log(`product TeamGrid seeded — ${config.segments.length} segments, ${config.suggestedChannels.length} suggested channels`);

  const written = await generateDefaultTemplates(ORG, String(PRODUCT), config);
  console.log(`templates generated: ${written}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
