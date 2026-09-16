/**
 * The rolling planner's pure decisions: when a lead's next plan is asked for, how a team
 * size becomes a group, how ideas are counted, and how plain-text links are tracked.
 *
 *   MASTER_KEY_B64=$(openssl rand -base64 32) npx tsx src/scripts/verify-rolling.ts
 */
import { CHECKPOINT_PLAN_WAIT_MS, checkpoint, companyTokens, groupFor, isRolling, isRollingPlan, teamBand, themeSlug, unlabelledNumbers, watchWindowMs } from "../engine/rolling";
import { applyTextTracking } from "../engine/tracking";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

const H = 3_600_000;
const now = new Date("2026-09-17T10:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * H);

console.log("checkpoint");
check("nothing sent yet → ask", checkpoint({ now }).kind === "ask");
check("email sent 10 h ago, no signal → watch", checkpoint({ now, lastSentAt: ago(10), lastChannel: "email" }).kind === "watch");
check("email sent 49 h ago → ask (window closed)", (() => {
  const d = checkpoint({ now, lastSentAt: ago(49), lastChannel: "email" });
  return d.kind === "ask" && d.reason === "window_closed";
})());
check("whatsapp sent 25 h ago → ask", checkpoint({ now, lastSentAt: ago(25), lastChannel: "whatsapp" }).kind === "ask");
check("call ended 3 h ago → ask", checkpoint({ now, lastSentAt: ago(3), lastChannel: "voice" }).kind === "ask");
check("clicked after the send → ask at once, even inside the window", (() => {
  const d = checkpoint({ now, lastSentAt: ago(5), lastChannel: "email", signalAt: ago(1) });
  return d.kind === "ask" && d.reason === "signal";
})());
check("a click from before the last send does not end the window", checkpoint({ now, lastSentAt: ago(5), lastChannel: "email", signalAt: ago(30) }).kind === "watch");
check("asked 2 h ago, no plan since → waiting", checkpoint({ now, lastSentAt: ago(60), askedAt: ago(2) }).kind === "waiting");
check("asked 13 h ago, no plan since → fallback", checkpoint({ now, lastSentAt: ago(60), askedAt: ago(13) }).kind === "fallback");
check("asked 13 h ago but a plan was written after → not waiting on it", (() => {
  const d = checkpoint({ now, lastSentAt: ago(60), askedAt: ago(13), planWrittenAt: ago(12) });
  return d.kind === "ask";
})());
check("plan written after the ask, its touch sent 1 h ago → watch", checkpoint({ now, lastSentAt: ago(1), askedAt: ago(20), planWrittenAt: ago(19) }).kind === "watch");
check("fallback wait is 12 h", CHECKPOINT_PLAN_WAIT_MS === 12 * H);
check("unknown channel watches like email", watchWindowMs("carrier_pigeon") === watchWindowMs("email"));

console.log("mode");
check("rolling campaign", isRolling({ perLeadPlan: { family: "feature_followup", mode: "rolling" } }));
check("per-lead campaign without mode is not rolling", !isRolling({ perLeadPlan: { family: "feature_followup" } }));
check("no campaign is not rolling", !isRolling(null));
check("plan marked rolling", isRollingPlan({ rolling: true }));
check("older plan is not", !isRollingPlan({ createdBy: "claude" }));

console.log("groups");
check("11–50 (en dash)", teamBand("11–50") === "11-50");
check("1–10", teamBand("1–10") === "1-10");
check("51–200", teamBand("51–200") === "51-200");
check("200+", teamBand("200+") === "200+");
check("about 30", teamBand("about 30") === "11-50");
check("blank", teamBand("") === "unknown");
check("group joins segment and band", groupFor({ belief: { segment: "founder" }, enrichment: { form: { team_size: "11–50" } } }) === "founder|11-50");
check("unread person", groupFor({}) === "unclassified|unknown");

console.log("themes");
check("slug ignores case and punctuation", themeSlug("Evening status-calls!") === themeSlug("evening status calls"));
check("slug keeps words apart", themeSlug("Evening status calls") === "evening_status_calls");

console.log("copy checks");
check("company from domain", companyTokens({ companyDomain: "http://www.housez24.com/" }).includes("housez24"));
check("short domain label is not a name", companyTokens({ companyDomain: "abc.in" }).length === 0);
check("a rupee figure with no example wording is flagged", unlabelledNumbers("Your team loses ₹6.7 lakh every month.").length > 0);
check("the same figure called an example is not", unlabelledNumbers("For example, a team of 50 loses ₹6.7 lakh a month.").length === 0);
check("plain words with no numbers are not", unlabelledNumbers("Most teams end the day with calls.").length === 0);

console.log("plain-text links");
process.env.MASTER_KEY_B64 ??= Buffer.from("verify-rolling-key-verify-rolling").toString("base64");
const origin = "https://app.example.com";
const optOut = "https://app.example.com/api/u/abc?s=1";
const text = `Start your free trial: https://teamgrid.ai/register?p=1.\n\nNot useful? Unsubscribe: ${optOut}`;
const once = applyTextTracking(text, { actionId: "a1", origin, choice: { opens: false, clicks: true }, neverTrack: [optOut] });
check("trial link wrapped", once.text.includes(`${origin}/api/t/c/a1?u=`));
check("sentence full stop stays outside the link", /s=[0-9a-f]+\.\n/.test(once.text));
check("unsubscribe left direct", once.text.includes(`Unsubscribe: ${optOut}`));
check("reports a trackable click", once.clicks);
const twice = applyTextTracking(once.text, { actionId: "a1", origin, choice: { opens: false, clicks: true }, neverTrack: [optOut] });
check("idempotent", twice.text === once.text);
const noConsent = applyTextTracking(text, { actionId: "a1", origin, choice: { opens: false, clicks: false } });
check("no consent → untouched", noConsent.text === text && !noConsent.clicks);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
