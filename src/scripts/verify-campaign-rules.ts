import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import {
  ABSENCE_DEFAULT_DAYS,
  autoReplyKind,
  holdForAbsence,
  holdOf,
  REPLIED_REASON,
  resumeAtFor,
  returnDateFrom,
  pauseForReply,
  stopForMeeting,
  writtenBeforeReply,
} from "../engine/campaignRules.js";
import { advance } from "../engine/advance.js";

/**
 * The three campaign rules (engine/campaignRules.ts): the pure readers first, then the
 * database side on a throwaway org that is deleted at the end.
 *
 *   npm run verify:rules
 */

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "  ok " : "  FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "none");
const DAY = 86_400_000;

// A Tuesday, 11:00 in India.
const sent = new Date("2026-09-22T05:30:00Z");

console.log("\nautomatic replies");
const h = (headers: Record<string, string>) => (name: string) => headers[name];
check("Gmail vacation responder", autoReplyKind(h({ "Auto-Submitted": "auto-replied" }), "Re: 9 hours paid", "I am on leave until 5 October with limited access to email.") === "absence");
check("Outlook automatic reply by subject", autoReplyKind(h({}), "Automatic reply: 9 hours paid", "I am out of the office until Friday.") === "absence");
check("a ticket acknowledgement is automatic but not absence", autoReplyKind(h({ "Auto-Submitted": "auto-generated" }), "We received your request", "Thank you for contacting support.") === "auto");
check("Auto-Submitted: no is a person", autoReplyKind(h({ "Auto-Submitted": "no" }), "Re: hours", "Sounds good, send details.") === null);
check("a person who mentions leave still wrote a real reply", autoReplyKind(h({}), "Re: 9 hours paid", "I am on leave till Monday but yes, send me the pricing.") === null);
check("X-Autoreply header", autoReplyKind(h({ "X-Autoreply": "yes" }), "Re: hi", "Out of office.") === "absence");

console.log("\nreturn dates");
check("'until 5 October'", iso(returnDateFrom("I am on leave until 5 October.", sent)) === "2026-10-05", iso(returnDateFrom("I am on leave until 5 October.", sent)));
check("'back on Oct 6th'", iso(returnDateFrom("Back on Oct 6th.", sent)) === "2026-10-06");
check("'from 1 Oct to 5 Oct' takes the last", iso(returnDateFrom("Away from 1 Oct to 5 Oct", sent)) === "2026-10-05");
check("Indian 5/10 is 5 October", iso(returnDateFrom("Returning 5/10/2026", sent)) === "2026-10-05");
check("ISO date", iso(returnDateFrom("back 2026-09-30", sent)) === "2026-09-30");
check("weekday means the next one", iso(returnDateFrom("I will be back on Monday", sent)) === "2026-09-28");
check("tomorrow", iso(returnDateFrom("back tomorrow", sent)) === "2026-09-23");
check("a time is not a date", returnDateFrom("call me at 10.30 or 5.45", sent) === null);
check("a past date does not count", returnDateFrom("away since 3 March", sent) === null);
check("a date months away does not count", returnDateFrom("back on 20 December", sent) === null);
check("no date at all", returnDateFrom("I am out of the office.", sent) === null);
{
  const r = resumeAtFor("until 5 October", sent);
  check("resumes the morning after, 09:30 IST", r.at.toISOString() === "2026-10-06T04:00:00.000Z" && r.fromMessage, r.at.toISOString());
  const d = resumeAtFor("I am out of the office.", sent);
  check(`no date: ${ABSENCE_DEFAULT_DAYS} days`, d.at.toISOString() === "2026-09-29T04:00:00.000Z" && !d.fromMessage, d.at.toISOString());
}

console.log("\nhold");
check("a hold in the future holds", holdOf({ holdUntil: new Date(Date.now() + DAY), holdReason: "x" }) !== null);
check("a hold in the past is over", holdOf({ holdUntil: new Date(Date.now() - 1000) }) === null);
check("no hold", holdOf({}) === null && holdOf(null) === null);

console.log("\nthey wrote back");
{
  // The 21 September case: written in the morning, reply at night, approved next morning.
  const morning = ObjectId.createFromTime(Math.floor(new Date("2026-09-21T06:22:50Z").getTime() / 1000));
  // The reply is on the campaign it answered.
  const reply = { lastReplyAt: new Date("2026-09-21T17:40:52Z") };
  check("a mail written before the reply is stale", writtenBeforeReply({ _id: morning, angle: "loss_first" }, reply));
  check("approving it later does not freshen it", writtenBeforeReply({ _id: morning, angle: "loss_first", reviewedAt: new Date("2026-09-22T04:56:12Z") }, reply));
  check("a rewrite after the reply is fresh", !writtenBeforeReply({ _id: morning, angle: "loss_first", rewrittenAt: new Date("2026-09-22T07:00:00Z") }, reply));
  const evening = ObjectId.createFromTime(Math.floor(new Date("2026-09-22T06:00:00Z").getTime() / 1000));
  check("a mail written after the reply goes", !writtenBeforeReply({ _id: evening, angle: "next_touch" }, reply));
  check("an answer to them is never stale", !writtenBeforeReply({ _id: morning, angle: "reply" }, reply));
  check("nobody replied in this campaign, nothing is stale", !writtenBeforeReply({ _id: morning, angle: "loss_first" }, {}));
}

// ── database ────────────────────────────────────────────────────────────────
console.log("\ndatabase (throwaway org)");
const db = await getDb();
const orgId = `verify-rules-${new ObjectId().toString()}`;
const productId = new ObjectId().toString();
const now = new Date();
try {
  const person = async (email: string, companyDomain?: string) => {
    const _id = new ObjectId();
    await db.collection(C.people).insertOne({ _id, orgId, productId, primaryEmail: email, ...(companyDomain !== undefined ? { companyDomain } : {}), identities: [{ kind: "email", value: email }] });
    const gi = new ObjectId();
    await db.collection(C.goalInstances).insertOne({ _id: gi, orgId, productId, personId: String(_id), goalKey: "t", status: "active", deadline: new Date(now.getTime() + 3 * DAY), spent: { touches: 1 } });
    const action = new ObjectId();
    await db.collection(C.actions).insertOne({ _id: action, orgId, productId, personId: String(_id), goalInstanceId: String(gi), status: "queued", angle: "x", idempotencyKey: `${orgId}:${String(action)}`, dueAt: new Date(now.getTime() + 3_600_000) });
    return { id: String(_id), gi, action };
  };
  const gmailB = await person("b@gmail.com", "gmail.com");

  // Rule 1: an away reply holds the campaign it came back on, and only that one.
  const away1 = await person("sam@other.in", "other.in");
  const sentMail = new ObjectId();
  await db.collection(C.actions).insertOne({ _id: sentMail, orgId, productId, personId: away1.id, goalInstanceId: String(away1.gi), status: "sent", sentAt: now, angle: "x", idempotencyKey: `${orgId}:${String(sentMail)}`, dueAt: now });
  const theirWhatsApp = new ObjectId();
  await db.collection(C.goalInstances).insertOne({ _id: theirWhatsApp, orgId, productId, personId: away1.id, goalKey: "wa", status: "active", deadline: new Date(now.getTime() + 3 * DAY), spent: { touches: 1 } });
  const away = await holdForAbsence({ orgId, productId, answeredActionId: String(sentMail), text: "Automatic reply: out of office until 5 October", sent: now, now });
  const awayGi = await db.collection(C.goalInstances).findOne({ _id: away1.gi });
  check("out of office holds the campaign it came back on", away.held === 1 && awayGi?.holdKind === "absence" && /out of office/.test(String(awayGi?.holdReason)));
  check("deadline moved past the hold", new Date(awayGi?.deadline).getTime() > away.until.getTime());
  check("its message waits for the return", (await db.collection(C.actions).findOne({ _id: away1.action }))?.dueAt?.getTime() === away.until.getTime());
  check("their campaign on another channel is not held", !(await db.collection(C.goalInstances).findOne({ _id: theirWhatsApp }))?.holdUntil);
  check("event on their timeline", (await db.collection(C.events).countDocuments({ orgId, personId: away1.id, type: "campaign_held" })) === 1);
  check("an away reply to nothing of ours holds nothing", (await holdForAbsence({ orgId, productId, text: "Out of office until 5 October", sent: now, now })).held === 0);

  // No colleague rule: someone at the same company replying changes nothing for anyone else.
  const replier = await person("asha@acme.in", "acme.in");
  const mate = await person("ravi@acme.in", "acme.in");
  const replierSent = new ObjectId();
  await db.collection(C.actions).insertOne({ _id: replierSent, orgId, productId, personId: replier.id, goalInstanceId: String(replier.gi), status: "sent", sentAt: now, angle: "x", idempotencyKey: `${orgId}:${String(replierSent)}`, dueAt: now });
  await pauseForReply({ orgId, productId, answeredActionId: String(replierSent), at: now });
  const mateAction = await db.collection(C.actions).findOne({ _id: mate.action });
  check("a colleague's campaign runs on", !(await db.collection(C.goalInstances).findOne({ _id: mate.gi }))?.holdUntil && mateAction?.status === "queued" && !mateAction?.deferReason);

  const stop = await stopForMeeting({ orgId, productId, personId: gmailB.id, source: "booked on your site", now });
  const stopped = await db.collection(C.goalInstances).findOne({ _id: gmailB.gi });
  check("a booking skips what was waiting and stops the sequence", stop.skipped === 1 && stop.stopped === 1 && Boolean(stopped?.handedOverAt) && stopped?.status === "active");
  check("booking again changes nothing", (await stopForMeeting({ orgId, productId, personId: gmailB.id, source: "booking page", now })).stopped === 0);

  // Rule 3: the campaign they answered drops what it had waiting, in Review and approved
  // alike; an answer stays, and their campaign on another channel is not touched.
  const wrote = await person("vinit@studio.in", "studio.in");
  const whatsappGi = new ObjectId();
  await db.collection(C.goalInstances).insertOne({ _id: whatsappGi, orgId, productId, personId: wrote.id, goalKey: "wa", status: "active", deadline: new Date(now.getTime() + 3 * DAY), spent: { touches: 1 } });
  const add = async (fields: Record<string, unknown>, gi = wrote.gi) => {
    const _id = new ObjectId();
    await db.collection(C.actions).insertOne({ _id, orgId, productId, personId: wrote.id, goalInstanceId: String(gi), angle: "x", idempotencyKey: `${orgId}:${String(_id)}`, dueAt: now, ...fields });
    return _id;
  };
  const inReview = await add({ status: "awaiting_approval" });
  const approved = await add({ status: "queued", reviewedAt: now });
  const channelHeld = await add({ status: "held" });
  const answer = await add({ status: "awaiting_approval", angle: "reply" });
  const alreadySent = await add({ status: "sent", sentAt: now });
  const otherCampaign = await add({ status: "awaiting_approval", channel: "whatsapp" }, whatsappGi);
  const replyEvent = new ObjectId();
  await db.collection(C.events).insertOne({ _id: replyEvent, orgId, productId, personId: wrote.id, type: "reply_received", channel: "email", actionId: String(alreadySent), ts: now, handled: false });
  const paused = await pauseForReply({ orgId, productId, answeredActionId: String(alreadySent), eventId: replyEvent, at: now });
  const statusOf = async (id: ObjectId) => (await db.collection(C.actions).findOne({ _id: id }))?.status;
  check("the queued, in-Review, approved and held messages are all dropped", paused.skipped === 4 && (await statusOf(inReview)) === "skipped" && (await statusOf(approved)) === "skipped" && (await statusOf(channelHeld)) === "skipped" && (await statusOf(wrote.action)) === "skipped", String(paused.skipped));
  check("with the reason the person page explains", (await db.collection(C.actions).findOne({ _id: inReview }))?.skipReason === REPLIED_REASON);
  check("the answer to them is kept", (await statusOf(answer)) === "awaiting_approval");
  check("what already went is untouched", (await statusOf(alreadySent)) === "sent");
  check("their campaign on another channel runs on", (await statusOf(otherCampaign)) === "awaiting_approval");
  check("the reply is on the campaign it answered", String((await db.collection(C.goalInstances).findOne({ _id: wrote.gi }))?.lastReplyAt) === String(now) && !(await db.collection(C.goalInstances).findOne({ _id: whatsappGi }))?.lastReplyAt);
  check("and the reply names its campaign", (await db.collection(C.events).findOne({ _id: replyEvent }))?.goalInstanceId === String(wrote.gi));
  check("a reply to nothing of ours pauses nothing", (await pauseForReply({ orgId, productId, at: now })).goalInstanceId === null);

  // And that campaign plans nothing new until they have been answered, whether its plan has
  // steps left or not; a reply marked answered by a person counts as the answer.
  await db.collection(C.goals).insertOne({ orgId, productId, key: "reply-pause", allowedChannels: ["email"] });
  const planned = async (email: string, lastReplyAt?: Date) => {
    const pid = new ObjectId();
    const planId = new ObjectId();
    const gi = new ObjectId();
    await db.collection(C.people).insertOne({ _id: pid, orgId, productId, primaryEmail: email, identities: [{ kind: "email", value: email }], lifecycle: "active", ...(lastReplyAt ? { lastReplyAt } : {}) });
    await db.collection(C.plans).insertOne({ _id: planId, orgId, productId, steps: [{ id: 1, channel: "email", angle: "one", offsetDays: 0 }, { id: 2, channel: "email", angle: "two", offsetDays: 0 }] });
    await db.collection(C.goalInstances).insertOne({ _id: gi, orgId, productId, personId: String(pid), goalKey: "reply-pause", status: "active", currentPlanId: String(planId), startedAt: new Date(now.getTime() - 5 * DAY), deadline: new Date(now.getTime() + 10 * DAY), spent: { touches: 1 }, ...(lastReplyAt ? { lastReplyAt } : {}) });
    return { id: String(pid), gi: String(gi) };
  };
  const reasonFor = async (gi: string) => (await advance(orgId, productId, 50, now)).skipped.find((x) => x.goalInstanceId === gi)?.reason ?? "";
  const PAUSED = "they replied; the conversation is being answered first";
  const dayAgo = new Date(now.getTime() - DAY);
  const repliedLead = await planned("mid@plan.in", dayAgo);
  await db.collection(C.events).insertOne({ orgId, productId, personId: repliedLead.id, goalInstanceId: repliedLead.gi, type: "reply_received", channel: "email", ts: dayAgo, handled: true, handledAt: new Date(dayAgo.getTime() + 3_600_000) });
  check("a plan with steps left still waits for the answer", (await reasonFor(repliedLead.gi)) === PAUSED);
  await db.collection(C.events).updateOne({ orgId, personId: repliedLead.id, type: "reply_received" }, { $set: { handledBy: "person", handledAt: new Date(now.getTime() - 3_600_000) } });
  check("marked answered by a person, the campaign carries on", (await reasonFor(repliedLead.gi)) !== PAUSED);
  const minuteAgo = new Date(now.getTime() - 60_000);
  await db.collection(C.events).insertOne({ orgId, productId, personId: repliedLead.id, goalInstanceId: repliedLead.gi, type: "reply_received", channel: "email", ts: minuteAgo, handled: false });
  await db.collection(C.goalInstances).updateOne({ _id: new ObjectId(repliedLead.gi) }, { $set: { lastReplyAt: minuteAgo } });
  check("a newer reply waits again", (await reasonFor(repliedLead.gi)) === PAUSED);
  const elsewhere = await planned("wa@plan.in");
  await db.collection(C.people).updateOne({ _id: new ObjectId(elsewhere.id) }, { $set: { lastReplyAt: dayAgo } });
  check("a reply in their other campaign does not pause this one", (await reasonFor(elsewhere.gi)) !== PAUSED);
} finally {
  for (const c of [C.people, C.goalInstances, C.actions, C.events, C.goals, C.plans, C.workQueue]) await db.collection(c).deleteMany({ orgId });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
