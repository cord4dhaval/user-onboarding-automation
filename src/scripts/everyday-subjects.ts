import { readFileSync } from "node:fs";
import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { companyTokens, plainSubjectProblems, subjectShapeProblems, theirWords } from "../engine/rolling.js";

/**
 * Every unsent subject, rewritten in everyday English said the way a person talks (2026-09-29).
 *
 * Dhaval read the review queue and could not tell what "Pause, or keep going?" or "The evening
 * ask, skipped" were about, so a lead could not either. He chose two methods together: talk, do
 * not write (one spoken sentence with a doing word, speaking to them), and easy words only (every
 * word on the everyday list, their own word, or an Indian office word). Both are now what
 * compose_batch enforces; this brings the mails written before the rule up to it.
 *
 * The list is docs/subjects/everyday-2026-09-29.json: 154 lines written per lead and 44 mails
 * rendered from 7 feature templates. Each line is checked here against the lead's own words and
 * company name, exactly as compose_batch checks a new one, and only a line that passes is written.
 *
 * Only the inbox line changes: content.subject, and the <title> inside the rendered HTML. The
 * body is not touched and nothing is re-rendered. With --apply the 7 feature templates get the
 * same new line as their subject, so the next mail they render carries it too.
 *
 *   npm run subjects:everyday              check them and write nothing
 *   npm run subjects:everyday -- --apply   write the ones that pass
 */

const WAITING = ["awaiting_approval", "queued"];
const LIST = "docs/subjects/everyday-2026-09-29.json";

const TEMPLATES: Record<string, string> = {
  replaces_tools: "One app writes your team's daily update",
  four_lines: "Stop asking your team what they did",
  hours_by_project: "See which client takes most of your time",
  attendance_auto: "See who really works in your office",
  blockers_early: "Know when your work gets stuck",
  ask_teamgrid: "Ask why your week was slow",
  quick_setup: "Start in 5 minutes on your laptop",
};

type Row = { id: string; goal: string; ask: "link" | "reply"; name: string; was: string; now: string; source: string };

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = JSON.parse(readFileSync(LIST, "utf8")) as Row[];
  const db = await getDb();
  console.log(`database ${db.databaseName}, ${rows.length} lines\n`);

  const ready: Array<{ row: Row; action: Document }> = [];
  let refused = 0;
  let gone = 0;
  for (const row of rows) {
    const action = await db.collection(C.actions).findOne({ _id: new ObjectId(row.id), status: { $in: WAITING } });
    if (!action) { gone++; console.log(`skip     ${row.id} — sent, skipped or re-planned since`); continue; }
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
    const ask = String((action.content as { ask?: unknown }).ask ?? "link") === "reply" ? "reply" : "link";
    const problems = [...plainSubjectProblems(row.now, theirWords(person), companyTokens(person)), ...subjectShapeProblems(row.now, ask)];
    if (problems.length) {
      refused++;
      console.log(`REFUSED  "${row.now}"\n         - ${problems.join("\n         - ")}`);
      continue;
    }
    ready.push({ row, action });
  }
  for (const [key, line] of Object.entries(TEMPLATES)) {
    const problems = [...plainSubjectProblems(line), ...subjectShapeProblems(line)];
    if (problems.length) { refused++; console.log(`REFUSED  template ${key} "${line}"\n         - ${problems.join("\n         - ")}`); }
  }

  console.log(`\n${ready.length} pass, ${refused} refused, ${gone} no longer waiting.`);
  if (!apply) { console.log("Nothing written. Re-run with --apply."); return; }
  if (refused) { console.log("Nothing written: fix the refused lines first."); return; }

  for (const { row, action } of ready) {
    const content = action.content as { subject?: string; bodyHtml?: string };
    const set: Record<string, unknown> = { "content.subject": row.now, "content.subjectWas": row.was, "content.subjectRewrittenAt": new Date() };
    if (typeof content.bodyHtml === "string") {
      set["content.bodyHtml"] = content.bodyHtml.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(row.now)}</title>`);
    }
    await db.collection(C.actions).updateOne({ _id: action._id, status: { $in: WAITING } }, { $set: set });
  }
  console.log(`${ready.length} subjects rewritten. Bodies untouched, nothing sent.`);

  for (const [key, line] of Object.entries(TEMPLATES)) {
    const res = await db.collection(C.templates).updateOne(
      { key, status: "active", "blocks.type": "subject" },
      { $set: { "blocks.$[s].fallback": line, updatedAt: new Date() }, $inc: { version: 1 } },
      { arrayFilters: [{ "s.type": "subject" }] },
    );
    console.log(`template ${key}: ${res.modifiedCount ? `now "${line}"` : "not found"}`);
  }
}

void main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
