/**
 * Sets up the LinkedIn campaign for TeamGrid's hot leads, the same people the email (v3) and
 * WhatsApp campaigns reach, so each channel's results can be compared on one group.
 *
 *   tsx --env-file=.env src/scripts/setup-linkedin-campaign.ts          # show what it would do
 *   tsx --env-file=.env src/scripts/setup-linkedin-campaign.ts --apply  # do it
 *
 * What it does, once (running it again changes nothing that is already there):
 *   1. turns on the two LinkedIn templates the campaign needs: li_invite (the invite; a free
 *      account sends it without a note) and li_frame (the slot Claude's messages go in);
 *   2. creates the campaign: hot leads, goal "account created", Claude plans LinkedIn
 *      (routine 6), every message reviewed first;
 *   3. creates its lead source: BrandGrid list_leads every 10 minutes, starting from where the
 *      v3 source is now, so only new leads arrive through it;
 *   4. writes the profiles the 18 September search was sure of (high) or thought likely
 *      (medium) onto those leads; the rest are left for Claude's own search;
 *   5. adds v3's active leads to the campaign through the same ingest path a source uses.
 *
 * Run it only once the code that knows about profile finding is deployed: an older send path
 * skips any LinkedIn invite to a lead without a profile the minute it is queued.
 */

import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { runSource } from "../engine/runSource.js";
import { saveLinkedInFind, FindRefused } from "../engine/linkedinFind.js";
import { identityValue } from "../engine/address.js";

const PRODUCT_ID = "6a964454c4fa12977b6d6964";
const KEY = "linkedin_hot_leads";
const FROM_GOAL = "whatsapp_intro_hot_leads";
const V3 = "teamgrid_leads_v3";
const SHEET = "docs/leads/teamgrid-linkedin-urls.csv";
const apply = process.argv.includes("--apply");

function csvRows(path: string): Record<string, string>[] {
  const text = readFileSync(path, "utf8");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
}

async function main() {
  const db = await getDb();
  const model = await db.collection(C.goals).findOne({ productId: PRODUCT_ID, key: FROM_GOAL });
  if (!model) throw new Error(`${FROM_GOAL} not found`);
  const orgId = String(model.orgId);
  const say = (line: string) => console.log(`${apply ? "" : "[dry run] "}${line}`);

  // 1. templates
  for (const key of ["li_invite", "li_frame"]) {
    const t = await db.collection(C.templates).findOne({ orgId, productId: PRODUCT_ID, key, channel: "linkedin" });
    if (!t) throw new Error(`template ${key} not found`);
    if (t.status === "active") { say(`template ${key}: already active`); continue; }
    say(`template ${key}: ${String(t.status)} -> active`);
    if (apply) await db.collection(C.templates).updateOne({ _id: t._id }, { $set: { status: "active", activatedAt: new Date() } });
  }

  // 2. campaign
  const existing = await db.collection(C.goals).findOne({ orgId, productId: PRODUCT_ID, key: KEY });
  if (existing) say(`campaign ${KEY}: already there`);
  else {
    say(`campaign ${KEY}: create (hot, Claude plans LinkedIn, review on)`);
    if (apply) {
      await db.collection(C.goals).insertOne({
        orgId,
        productId: PRODUCT_ID,
        key: KEY,
        name: "LinkedIn hot leads",
        leadType: "hot",
        entry: { expression: "lead_created", minIcpFit: 0 },
        success: model.success,
        failure: model.failure,
        budget: { touches: 12, days: 45, usd: 12 },
        allowedChannels: ["linkedin"],
        channelIds: [],
        verifyConnectionId: model.verifyConnectionId,
        // Written by Claude, as for a campaign made in the console.
        checks: [],
        needsVerificationPlan: true,
        firstTouch: { templateKey: "li_invite", channels: ["linkedin"] },
        linkedin: { planner: "claude", frameKey: "li_frame" },
        schedule: { fetchEverySec: 600, tickEverySec: 600, bufferDepth: 3, approvalMode: "gate_on", firstTouchApproval: "follow_campaign" },
        cadenceByTemp: model.cadenceByTemp,
        sourceIds: [],
        discrimination: [],
        enabled: true,
        createdAt: new Date(),
      });
    }
  }

  // 3. source
  const v3Source = await db.collection(C.sources).findOne({ orgId, productId: PRODUCT_ID, defaultGoalKey: V3 });
  const waSource = await db.collection(C.sources).findOne({ orgId, productId: PRODUCT_ID, defaultGoalKey: FROM_GOAL });
  if (!v3Source || !waSource) throw new Error("v3 or WhatsApp source not found");
  let source = await db.collection(C.sources).findOne({ orgId, productId: PRODUCT_ID, defaultGoalKey: KEY });
  if (source) say(`source for ${KEY}: already there`);
  else {
    say(`source for ${KEY}: BrandGrid list_leads every 10 min, from ${String(v3Source.cursor)}`);
    if (apply) {
      const fieldMap = {
        ...(waSource.fieldMap as Record<string, unknown>),
        // For the day the form asks for it: a profile on the row skips the search.
        linkedin: ["fields.linkedin", "fields.linkedin_profile", "fields.linkedin url", "fields.linkedin_url", "linkedin"],
      };
      const id = new ObjectId();
      await db.collection(C.sources).insertOne({
        _id: id,
        orgId,
        productId: PRODUCT_ID,
        connectionId: waSource.connectionId,
        name: KEY,
        kind: "mcp_source",
        triggerMode: "batch",
        formLeads: true,
        desiredIntervalSec: 600,
        effectiveIntervalSec: 600,
        fieldMap,
        dedupeKey: "email",
        defaultGoalKey: KEY,
        enabled: true,
        cursor: v3Source.cursor,
        nextFetchAt: new Date(Date.now() + 10 * 60_000),
        health: { status: "healthy" },
      });
      source = await db.collection(C.sources).findOne({ _id: id });
    }
  }

  // 4. profiles from the 18 September search, for v3's active leads
  const instances = await db.collection(C.goalInstances).find({ orgId, productId: PRODUCT_ID, goalKey: V3, status: "active" }).project({ personId: 1 }).toArray();
  const people = await db
    .collection(C.people)
    .find({ _id: { $in: instances.map((i) => new ObjectId(String(i.personId))) } })
    .project({ primaryEmail: 1, name: 1, identities: 1, linkedinFind: 1, lifecycle: 1 })
    .toArray();
  const byEmail = new Map(people.map((p) => [String(p.primaryEmail ?? "").toLowerCase(), p]));
  let written = 0;
  for (const row of csvRows(SHEET)) {
    if (row.campaign !== V3 || !["high", "medium"].includes(row.confidence ?? "") || !row.linkedin) continue;
    const person = byEmail.get(String(row.email).trim().toLowerCase());
    if (!person || identityValue(person, "linkedin")) continue;
    const status = row.confidence === "high" ? "sure" : "likely";
    say(`profile for ${String(person.name)}: ${status} ${row.linkedin}`);
    if (!apply) continue;
    try {
      await saveLinkedInFind({
        orgId,
        productId: PRODUCT_ID,
        personId: String(person._id),
        status,
        url: row.linkedin,
        why: `The 18 September web search matched them by ${String(row.match_reason).replace(/[+_]/g, " ")}.`,
        evidence: row.linkedin_title || undefined,
        by: "import",
        notifyOwner: false,
      });
      written++;
    } catch (err) {
      console.log(`  not written: ${err instanceof FindRefused ? err.problems.join("; ") : String(err)}`);
    }
  }

  // 5. v3's active leads join the campaign, through the ingest path a source uses
  const rows = people
    .filter((p) => p.primaryEmail && p.lifecycle !== "suppressed")
    .map((p) => ({ email: String(p.primaryEmail), name: String(p.name ?? "") }));
  say(`add ${rows.length} of v3's ${instances.length} active leads to ${KEY}`);
  if (apply && source) {
    const summary = await runSource(String(source._id), rows);
    // A pushed batch has no cursor of its own; the source keeps v3's, so its first poll
    // reads only what arrived after it.
    await db.collection(C.sources).updateOne({ _id: source._id }, { $set: { cursor: v3Source.cursor, nextFetchAt: new Date(Date.now() + 10 * 60_000) } });
    console.log(JSON.stringify({ profilesWritten: written, ingest: summary }, null, 1).slice(0, 1500));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
