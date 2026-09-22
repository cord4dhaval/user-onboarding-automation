import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import {
  ABSENCE_DEFAULT_DAYS,
  COMPANY_HOLD_DAYS,
  autoReplyKind,
  companyKeyOf,
  holdForAbsence,
  holdOf,
  pauseCompanyMates,
  resumeAtFor,
  returnDateFrom,
  stopForMeeting,
} from "../engine/campaignRules.js";

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

console.log("\ncompany");
check("a plain domain", companyKeyOf("acme.in") === "acme.in");
check("a form's URL", companyKeyOf("https://www.Acme.in/about") === "acme.in");
check("gmail is nobody's company", companyKeyOf("gmail.com") === null);
check("empty is nobody's company", companyKeyOf("") === null && companyKeyOf(undefined) === null);
check("not a domain", companyKeyOf("www.abc") === null);

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
  const replier = await person("asha@acme.in", "acme.in");
  const mate = await person("ravi@acme.in", "https://www.acme.in/");
  const mateByEmail = await person("neha@acme.in");
  const other = await person("sam@other.in", "other.in");
  const gmailA = await person("a@gmail.com", "gmail.com");
  const gmailB = await person("b@gmail.com", "gmail.com");

  const result = await pauseCompanyMates({ orgId, productId, personId: replier.id, channel: "email", now });
  check("both colleagues held, by domain and by email", result.domain === "acme.in" && result.held === 2, JSON.stringify(result));
  const heldMate = await db.collection(C.goalInstances).findOne({ _id: mate.gi });
  const until = new Date(now.getTime() + COMPANY_HOLD_DAYS * DAY);
  check("hold lasts two weeks", heldMate?.holdUntil?.getTime() === until.getTime());
  check("deadline moved past the hold", new Date(heldMate?.deadline).getTime() > until.getTime());
  const movedAction = await db.collection(C.actions).findOne({ _id: mate.action });
  check("colleague's message kept and moved, with the reason", movedAction?.status === "queued" && movedAction?.dueAt?.getTime() === until.getTime() && /colleague at acme\.in/.test(String(movedAction?.deferReason)));
  check("the replier is not held by this rule", !(await db.collection(C.goalInstances).findOne({ _id: replier.gi }))?.holdUntil);
  check("another company is untouched", !(await db.collection(C.goalInstances).findOne({ _id: other.gi }))?.holdUntil);
  const g = await pauseCompanyMates({ orgId, productId, personId: gmailA.id, channel: "email", now });
  check("a gmail reply holds nobody", g.domain === null && g.held === 0 && !(await db.collection(C.goalInstances).findOne({ _id: gmailB.gi }))?.holdUntil);
  check("event on the colleague's timeline", (await db.collection(C.events).countDocuments({ orgId, personId: mate.id, type: "campaign_held" })) === 1);
  check("a second reply does not stack events", (await pauseCompanyMates({ orgId, productId, personId: replier.id, channel: "email", now })).held === 0);

  const away = await holdForAbsence({ orgId, productId, personId: other.id, text: "Automatic reply: out of office until 5 October", sent: now, now });
  const awayGi = await db.collection(C.goalInstances).findOne({ _id: other.gi });
  check("out of office holds their own campaign", away.held === 1 && awayGi?.holdKind === "absence" && /out of office/.test(String(awayGi?.holdReason)));
  check("their message waits for the return", (await db.collection(C.actions).findOne({ _id: other.action }))?.dueAt?.getTime() === away.until.getTime());

  const stop = await stopForMeeting({ orgId, productId, personId: gmailB.id, source: "booked on your site", now });
  const stopped = await db.collection(C.goalInstances).findOne({ _id: gmailB.gi });
  check("a booking skips what was waiting and stops the sequence", stop.skipped === 1 && stop.stopped === 1 && Boolean(stopped?.handedOverAt) && stopped?.status === "active");
  check("booking again changes nothing", (await stopForMeeting({ orgId, productId, personId: gmailB.id, source: "booking page", now })).stopped === 0);
} finally {
  for (const c of [C.people, C.goalInstances, C.actions, C.events]) await db.collection(c).deleteMany({ orgId });
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
