import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { repliesFor, repliesWaitingCount } from "../engine/replies.js";

/**
 * The Replies page's reading of each reply (engine/replies.ts), on a throwaway org that is
 * deleted at the end.
 *
 *   npm run verify:replies
 */

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "  ok " : "  FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const db = await getDb();
const orgId = `verify-replies-${new ObjectId().toString()}`;
const productId = new ObjectId().toString();
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
try {
  const person = async (name: string) => {
    const _id = new ObjectId();
    await db.collection(C.people).insertOne({ _id, orgId, productId, name, primaryEmail: `${name.toLowerCase()}@acme.in` });
    return String(_id);
  };
  const reply = async (personId: string, at: Date, text: string, extra: Record<string, unknown> = {}) => {
    const _id = new ObjectId();
    await db.collection(C.events).insertOne({ _id, orgId, productId, personId, type: "reply_received", channel: "email", ts: at, handled: false, payload: { text }, ...extra });
    return String(_id);
  };
  const answer = async (personId: string, dueAt: Date, status: string, extra: Record<string, unknown> = {}) =>
    db.collection(C.actions).insertOne({ orgId, productId, personId, angle: "reply", status, dueAt, idempotencyKey: `${orgId}:${new ObjectId().toString()}`, content: { slotText: "Here is the pricing." }, ...extra });

  const fresh = await person("Fresh");
  await reply(fresh, ago(10), "Is there a free trial?");
  const late = await person("Late");
  await reply(late, ago(300), "Can you call me?");
  const drafted = await person("Drafted");
  const draftedAt = ago(120);
  await reply(drafted, draftedAt, "What does it cost?", { handled: true });
  await db.collection(C.events).insertOne({ orgId, productId, personId: drafted, type: "reply_recorded", ts: draftedAt, payload: { intent: "question" } });
  await answer(drafted, draftedAt, "awaiting_approval");
  const sent = await person("Sent");
  const sentAt = ago(600);
  await reply(sent, sentAt, "Interested, tell me more");
  await answer(sent, sentAt, "sent", { reviewedAt: ago(590), sentAt: ago(580) });
  const no = await person("No");
  const noAt = ago(200);
  await reply(no, noAt, "Not for us", { handled: true });
  await db.collection(C.events).insertOne({ orgId, productId, personId: no, type: "reply_recorded", ts: noAt, payload: { intent: "no" } });
  const done = await person("Done");
  await reply(done, ago(400), "Call me", { handled: true, handledBy: "person" });
  const away = await person("Away");
  await db.collection(C.events).insertOne({ orgId, productId, personId: away, type: "auto_reply", channel: "email", ts: ago(30), payload: { text: "Out of office", kind: "absence", holdUntil: new Date(now.getTime() + 5 * 86_400_000) } });

  const rows = await repliesFor(orgId, productId, now);
  const by = (name: string) => rows.find((r) => r.name === name);
  check("seven rows", rows.length === 7, String(rows.length));
  check("a reply minutes old is not read yet", by("Fresh")?.state === "waiting" && by("Fresh")?.label === "Not read yet");
  check("a reply hours old with nothing done needs an answer", by("Late")?.state === "waiting" && by("Late")?.label === "Needs your answer");
  check("a drafted answer is 'drafted', with its tag and text", by("Drafted")?.state === "drafted" && by("Drafted")?.intent === "question" && by("Drafted")?.answer?.text === "Here is the pricing.");
  check("a sent answer is 'answered'", by("Sent")?.state === "answered" && Boolean(by("Sent")?.answer?.sentAt));
  check("'no' needs no answer", by("No")?.state === "closed");
  check("marked done by a person is answered", by("Done")?.state === "answered" && by("Done")?.label === "Marked done");
  check("out of office is automatic, with the resume date", by("Away")?.state === "automatic" && Boolean(by("Away")?.holdUntil));
  const waiting = await repliesWaitingCount(orgId, productId, now);
  check("menu count: two unread plus one drafted", waiting === 3, String(waiting));
} finally {
  for (const c of [C.people, C.events, C.actions]) await db.collection(c).deleteMany({ orgId });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
