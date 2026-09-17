/**
 * The rolling planner's pure decisions: when a lead's next plan is asked for, how a team
 * size becomes a group, how ideas are counted, and how plain-text links are tracked.
 *
 *   MASTER_KEY_B64=$(openssl rand -base64 32) npx tsx src/scripts/verify-rolling.ts
 */
import { CHECKPOINT_PLAN_WAIT_MS, checkpoint, companyTokens, emojiProneSymbols, groupFor, isRolling, isRollingPlan, layoutArm, spelledQuantities, teamBand, themeSlug, unlabelledNumbers, watchWindowMs } from "../engine/rolling";
import { applyTextTracking } from "../engine/tracking";
import { plain, renderTemplate, resolveBlocks } from "../engine/compose";
import { renderHtml, renderLetter } from "../engine/html";
import { expandShortUnsubscribe, shortUnsubscribeUrl } from "../engine/unsubscribe";
import { DEFAULT_KIT } from "../engine/brand";

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

console.log("written layout");
const frame = [
  { type: "subject", slot: "subject", fallback: "x" },
  { type: "text", fixed: "Hi {{first_name}}," },
  { type: "slot", name: "opening", instruct: "" },
  { type: "slot", name: "timeline", instruct: "" },
  { type: "slot", instruct: "", fallback: "fallback scene" },
  { type: "card", slot: "cost", accent: true },
  { type: "list", slot: "shows", style: "check" },
  { type: "slot", name: "limit", instruct: "" },
  { type: "slot", name: "question", instruct: "" },
  { type: "slot", name: "options", instruct: "" },
  { type: "cta", fixed: "Start your free trial", url: "{{trial_link}}" },
  { type: "text", fixed: "Best regards,\nThe TeamGrid Team" },
  { type: "system", fixed: "opt_out_block" },
];
const mv = { first_name: "Asha", full_name: "Asha", company: "", person_id: "p", trial_link: "https://t.example/x", opt_out_url: "https://u.example/api/u/long?s=abc", opt_out_short_url: "https://u.example/u/short" };
const full = renderTemplate(frame, mv, {
  subject: "A dealer order waiting five days?",
  slotText: "A quote waits for the engineer. **The dealer calls** to ask where it is.",
  slots: { opening: "**Before sowing, orders pile up behind one approval.**", question: "**Which sign-off holds up the most orders?**", limit: "Only work done on a computer is recorded." },
  parts: {
    cost: { title: "For example:", rows: [{ label: "₹4 lakh order × 5 days waiting", value: "5 days lost before sowing" }] },
    shows: { title: "What TeamGrid would show you:", items: ["which orders moved yesterday", "which are blocked, and at whose desk"] },
  },
  ask: "reply",
});
check("no emphasis markers in plain text", !full.bodyMd.includes("**"));
check("cost line: situation, then the arrow line under it", full.bodyMd.includes("₹4 lakh order × 5 days waiting\n→ 5 days lost before sowing"));
check("cost title directly above it", full.bodyMd.includes("For example:\n₹4 lakh"));
check("opt-out invites a reply and prints the short link", full.bodyMd.includes('Not useful? Reply "remove me" and we will not write again.\nUnsubscribe: https://u.example/u/short'));
check("the long signed link stays out of the text", !full.bodyMd.includes("api/u/long"));
check("shows as dash lines directly under their title", full.bodyMd.includes("What TeamGrid would show you:\n  – which orders moved yesterday\n  – which are blocked"));
check("reply ask drops the button", !full.bodyMd.includes("Start your free trial"));
check("opening before scene before question", full.bodyMd.indexOf("Before sowing") < full.bodyMd.indexOf("A quote waits") && full.bodyMd.indexOf("A quote waits") < full.bodyMd.indexOf("Which sign-off"));
const bare = renderTemplate(frame, mv, { slotText: "Just words.", slots: { opening: "Hi there.", question: "Yes?" } });
check("no parts means no empty box or list", !bare.bodyMd.includes("For example") && !bare.bodyMd.includes("–"));
const resolvedFull = resolveBlocks(frame as never, mv, { slotText: "s", slots: {}, parts: { cost: { rows: [{ label: "a", value: "b" }] } } } as never);
check("card comes from parts, tinted", resolvedFull.blocks.some((b) => b.kind === "card" && b.accent && b.fromParts));
check("sign-off lines sit together", full.bodyMd.includes("Best regards,\nThe TeamGrid Team"));
const signed = renderTemplate(frame, mv, { slotText: "Just words.\n\nBest regards,\nThe TeamGrid Team", slots: {} });
check("copy ending on the two-line sign-off is not printed twice", signed.bodyMd.split("The TeamGrid Team").length === 2);
const html = renderHtml(resolveBlocks(frame as never, mv, { slotText: "s", slots: {}, parts: { cost: { title: "For example:", rows: [{ label: "₹4 lakh order", value: "5 days lost" }] } } } as never), DEFAULT_KIT);
check("written cost value carries the arrow in HTML", html.includes("→ 5 days lost"));
const twoRows = renderTemplate(frame, mv, { slotText: "s", slots: {}, parts: { cost: { title: "For example:", rows: [{ label: "a", value: "b" }, { label: "c", value: "d" }] } } });
check("a blank line between cost rows", twoRows.bodyMd.includes("a\n→ b\n\nc\n→ d"));
const tested = renderTemplate(frame, mv, {
  slotText: "Scene.",
  slots: { opening: "**Open.**", timeline: "**Monday:** the drawing waits.\n**Friday:** the founder hears.", question: "**Which step?**", options: "Reply with one number:\n**1** = quotes\n**2** = dispatch" },
  ask: "reply",
});
check("timeline lines in plain text", tested.bodyMd.includes("Monday: the drawing waits.\nFriday: the founder hears."));
check("reply options in plain text", tested.bodyMd.includes("Which step?\n\nReply with one number:\n1 = quotes\n2 = dispatch"));
const letter = renderLetter(resolveBlocks(frame as never, mv, {
  slotText: "Scene with **one phrase**.",
  slots: { opening: "**Open.**", question: "**Which step?**", options: "Reply with one number:\n**1** = quotes" },
  parts: { cost: { title: "For example:", rows: [{ label: "₹4 lakh order", value: "5 days lost" }] }, shows: { title: "What TeamGrid would show you:", items: ["what moved"] } },
} as never));
check("letter: bold phrases", letter.includes("<strong>one phrase</strong>") && letter.includes("<strong>1</strong> = quotes"));
check("letter: no logo, box or button", !/<img|<table|border-radius|background:/.test(letter));
check("letter: cost as a line and an arrow", letter.includes("₹4 lakh order<br />&rarr; <strong>5 days lost</strong>"));
check("letter: the call to action is a link on its words", letter.includes('>Start your free trial</a>'));
check("letter: opt-out invites a reply", letter.includes('Reply "remove me", or <a href="https://u.example/api/u/long?s=abc">unsubscribe</a>'));

console.log("plain-text rules");
check("spelled quantities found", spelledQuantities("It waits five days, three of nine hours, for two sign-offs.").length === 3);
check("digits pass", spelledQuantities("It waits 5 days, 3 of 9 hours.").length === 0);
check("'one' is left alone", spelledQuantities("one engineer, one day").length === 0);
check("emoji-prone symbols caught", emojiProneSymbols("Done ✔ next ▶ ™").length === 3);
check("safe symbols pass", emojiProneSymbols("₹4 lakh × 5 → 20 – ok • ✓ ÷ =").length === 0);
check("Unicode bold caught", emojiProneSymbols("𝗯𝗼𝗹𝗱").length > 0);
const arms = Array.from({ length: 400 }, (_, i) => layoutArm(i.toString(16).padStart(24, "0"), "reply_options"));
const used = arms.filter((a) => a === "use").length;
check("test arms split roughly in half", used > 150 && used < 250);
check("a lead keeps its arm", layoutArm("6aa8f1c440e32dfa803fa375", "timeline") === layoutArm("6aa8f1c440e32dfa803fa375", "timeline"));
check("the two tests are independent", Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(24, "0")).some((id) => layoutArm(id, "timeline") !== layoutArm(id, "reply_options")));

console.log("short unsubscribe link");
const personHex = "6aa8f1c440e32dfa803fa375";
const short = shortUnsubscribeUrl("https://app.example.com/", personHex)!;
check("short link is short", short.length < 60 && short.startsWith("https://app.example.com/u/"));
const expanded = expandShortUnsubscribe(short.split("/u/")[1]!);
check("expands to the full signed path", expanded !== null && expanded.startsWith(`/api/u/${personHex}?s=`));
check("a tampered code is refused", expandShortUnsubscribe(short.split("/u/")[1]!.replace(/.$/, (c) => (c === "A" ? "B" : "A"))) === null);
check("garbage is refused", expandShortUnsubscribe("nonsense") === null);

check("plain() drops bold and italics", plain("**a** and _b_.") === "a and b.");

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
