import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { plainSubjectProblems, subjectShapeProblems, theirWords } from "../engine/rolling.js";

/**
 * The unsent subjects of teamgrid_leads_v3, said in school English (2026-09-28).
 *
 * Dhaval read the queue and said the lines were hard to read: these leads do not read English all
 * day, and the inbox line is where they decide. The words that cost us were ours, not theirs —
 * counselling, assessments, exhibition, revision, guesswork, candidate, corporate, versus,
 * sessions — along with phrasings that have to be parsed ("Facts the timber desk sees", "Where the
 * summit week went"). The trade word stays in the mail; it moves out of the subject.
 *
 * Only the subject changes. The body is left exactly as it is, and each new line is checked
 * against the same rules compose_batch enforces: 3 to 5 words, 18 to 45 characters, no digits and
 * no hard word, then written only onto mail that has not gone out.
 *
 * Second pass, the same day: the datasets say shorter still. Belkins over 5.5 million B2B cold
 * emails puts 2 to 4 words at the best open rate, Gong and 30MPC over 85 million put lines under 4
 * words at four times the reply rate of 13 or more, and a question line opens best of all — so the
 * four mails that ask for a reply now ask their question in the inbox line too. The old ban on the
 * question mark rested on a percentage nothing in this repo supports.
 *
 *   npm run subjects              check them and write nothing
 *   npm run subjects -- --apply   write the ones that pass
 */

/** Mail that has not gone out: waiting for approval, or queued for a later send. */
const WAITING = ["awaiting_approval", "queued"];

const SUBJECTS: Array<{ id: string; was: string; now: string }> = [
  { id: "6ab51b7343d73f65637b8206", was: "Where the summit week went", now: "Hours spent in show week" },
  { id: "6ab51d1f25db026c9bc57971", was: "Site round at Heaven Solar", now: "Evening calls to each site" },
  { id: "6ab61315aa36622d699a409a", was: "Why the panel job slowed", now: "Why panel work got slow" },
  { id: "6ab6756924bb3a88211b84f2", was: "Who started the assessments", now: "Who started work at nine" },
  { id: "6ab8b58e45e3d1a03e4b16e7", was: "Nobody is watched at Instabiz", now: "Your team is not watched" },
  { id: "6ab8b5b145e3d1a03e4b16f6", was: "The evening simulator call", now: "The evening update call" },
  { id: "6ab8b5b445e3d1a03e4b16f8", was: "About your corporate rides", now: "About your car bookings" },
  { id: "6ab8b5c645e3d1a03e4b1706", was: "A question for the owner", now: "One question for you" },
  { id: "6ab8b5e645e3d1a03e4b1712", was: "What the security team runs", now: "What apps each team uses" },
  { id: "6ab8b5f345e3d1a03e4b1717", was: "The counselling call that waited", now: "The call no one returned" },
  { id: "6ab8b63245e3d1a03e4b172b", was: "The gases billing desk", now: "Time at the billing desk" },
  { id: "6ab8c3c545e3d1a03e4b18c8", was: "The hour between sessions", now: "The hour between two clients" },
  { id: "6ab8c3f4d67f616fb997b8d5", was: "Before the next hire", now: "Before you hire more people" },
  { id: "6ab8c422d67f616fb997b8e7", was: "Who carries the parts desk", now: "Who does the most work" },
  { id: "6ab8c430d67f616fb997b8ef", was: "Start with the export desk", now: "Start with one team only" },
  { id: "6ab8c450d67f616fb997b8f9", was: "Late nights nobody flagged", now: "Who is working late again" },
  { id: "6ab8c451d67f616fb997b8fb", was: "The exhibition revision calls", now: "Calls that change the plan" },
  { id: "6ab8c466d67f616fb997b902", was: "Facts the timber desk sees", now: "Numbers you both can see" },
  { id: "6ab8d195d67f616fb997bae8", was: "The raise you cannot prove", now: "Who should get the raise" },
  { id: "6ab9f911b4831d0f9b5e001b", was: "Pings between every shift", now: "Work waits for a reply" },
  { id: "6ab9f946b4831d0f9b5e0022", was: "The chat window stays open", now: "WhatsApp open all day" },
];

/** Second pass: the same lines, cut to 3 or 4 words, and a question where the mail asks for one. */
const SHORTER: Array<{ id: string; now: string }> = [
  { id: "6ab8b5c645e3d1a03e4b1706", now: "Keep this open?" },
  { id: "6ab8b5b445e3d1a03e4b16f8", now: "Close this out?" },
  { id: "6ab8c430d67f616fb997b8ef", now: "Start with one team?" },
  { id: "6aba08e317f6596a84f9263f", now: "No IT team needed?" },
  { id: "6ab51d1f25db026c9bc57971", now: "Evening site calls" },
  { id: "6ab8b5b145e3d1a03e4b16f6", now: "Evening update call" },
  { id: "6ab8c3c545e3d1a03e4b18c8", now: "The hour between clients" },
  { id: "6ab8c450d67f616fb997b8f9", now: "Who is working late" },
  { id: "6ab8c3f4d67f616fb997b8d5", now: "Before you hire again" },
  { id: "6ab8b5f345e3d1a03e4b1717", now: "The call nobody returned" },
  { id: "6ab8b63245e3d1a03e4b172b", now: "Billing desk hours" },
  { id: "6ab8b5e645e3d1a03e4b1712", now: "What each team uses" },
  { id: "6ab8b58e45e3d1a03e4b16e7", now: "Nobody is watched" },
  { id: "6ab8c451d67f616fb997b8fb", now: "Calls that change plans" },
  { id: "6ab8c466d67f616fb997b902", now: "Numbers you both see" },
  { id: "6aba088617f6596a84f92622", now: "Desk or showroom work" },
  { id: "6aba08ac17f6596a84f9262e", now: "Desk or site work" },
  { id: "6aba158d7917922a2a13dac9", now: "The price never sent" },
  { id: "6aba1619b8ef631f29a57ff5", now: "The hiring sheet" },
  { id: "6aba162bb8ef631f29a57ff8", now: "Next month, by guess" },
  { id: "6ab9f911b4831d0f9b5e001b", now: "Work waits for replies" },
  { id: "6aba08e717f6596a84f92641", now: "Your evening calls, done" },
  { id: "6aba315bb3e283f3c0e3fa0f", now: "Not a watching tool" },
  { id: "6aba31acb3e283f3c0e3fa26", now: "Nobody watches anyone" },
  { id: "6aba31a1b3e283f3c0e3fa22", now: "The same Monday review" },
  { id: "6aba31bcb3e283f3c0e3fa2c", now: "The raise, from memory" },
  { id: "6aba31bab3e283f3c0e3fa2a", now: "The work with no end" },
  { id: "6ab51b7343d73f65637b8206", now: "Hours in show week" },
  { id: "6ab61315aa36622d699a409a", now: "Why panel work slowed" },
  { id: "6ab8d195d67f616fb997bae8", now: "Who earned the raise" },
  { id: "6ab6756924bb3a88211b84f2", now: "Who started at nine" },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  console.log(`database ${db.databaseName}\n`);

  // The mails the routine wrote itself are matched by their subject, because their ids move as the
  // engine re-plans; the ones rewritten by hand are matched by id.
  const BY_TEXT: Array<{ was: string; now: string }> = [
    { was: "Desk time or showroom floor", now: "Desk work or showroom work" },
    { was: "Desk work versus site work", now: "Desk work or site work" },
    { was: "No IT team required", now: "You need no IT team" },
    { was: "Your evening round, already done", now: "We do the evening calls" },
    { was: "The evening quote question", now: "The price nobody sent back" },
    { was: "The request that waited days", now: "The request nobody answered" },
    { was: "The candidate tracker sheet", now: "The hiring sheet nobody fills" },
    { was: "Planning next month by guesswork", now: "Planning next month by guess" },
  ];

  const ids = (await db.collection(C.goalInstances).find({ goalKey: "teamgrid_leads_v3" }, { projection: { _id: 1 } }).toArray()).map((i) => String(i._id));
  const unsent = await db.collection(C.actions).find({ goalInstanceId: { $in: ids }, status: { $in: WAITING } }).toArray();
  const byId = new Map(unsent.map((a) => [String(a._id), a]));
  const bySubject = new Map(unsent.map((a) => [String((a.content as { subject?: unknown }).subject ?? ""), a]));

  const jobs: Array<{ action: Record<string, unknown>; now: string; was: string }> = [];
  // The shorter lines win where a mail has both, so they are collected first and the first pass
  // only fills in anything they missed.
  const taken = new Set<string>();
  for (const row of SHORTER) {
    const action = byId.get(row.id);
    if (!action) { console.log(`skip  ${row.id} — no longer unsent`); continue; }
    taken.add(row.id);
    jobs.push({ action, now: row.now, was: String((action.content as { subject?: unknown }).subject ?? "") });
  }
  for (const row of SUBJECTS) {
    if (taken.has(row.id)) continue;
    const action = byId.get(row.id);
    if (!action) { console.log(`skip  ${row.id} — no longer unsent`); continue; }
    jobs.push({ action, now: row.now, was: String((action.content as { subject?: unknown }).subject ?? "") });
  }
  for (const row of BY_TEXT) {
    const action = bySubject.get(row.was);
    if (!action) { console.log(`skip  "${row.was}" — not in the queue now`); continue; }
    jobs.push({ action, now: row.now, was: row.was });
  }

  let refused = 0;
  const ready: typeof jobs = [];
  for (const job of jobs) {
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(job.action.personId)) });
    const theirs = theirWords(person);
    const ask = String((job.action.content as { ask?: unknown }).ask ?? "link") === "reply" ? "reply" : "link";
    const f = [...plainSubjectProblems(job.now, theirs), ...subjectShapeProblems(job.now, ask)];
    console.log(`${f.length ? "REFUSED" : "ok     "} "${job.was}" -> "${job.now}"${f.length ? `  (${f.join("; ")})` : ""}`);
    if (f.length) refused++; else ready.push(job);
  }

  console.log(`\n${ready.length} of ${jobs.length} pass, ${refused} refused.`);
  if (!apply) { console.log("Nothing written. Re-run with --apply."); return; }

  for (const job of ready) {
    await db.collection(C.actions).updateOne(
      { _id: new ObjectId(String(job.action._id)), status: { $in: WAITING } },
      // The rendered copy goes with it, so the inbox line and the mail are rebuilt together.
      { $set: { "content.subject": job.now }, $unset: { "content.bodyMd": "", "content.bodyHtml": "" } },
    );
    console.log(`  written: ${String(job.action._id)} "${job.now}"`);
  }
  console.log(`\n${ready.length} subjects rewritten. Bodies untouched, nothing sent.`);
}

void main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
