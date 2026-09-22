/**
 * The rolling planner's pure decisions: when a lead's next plan is asked for, how a team
 * size becomes a group, how ideas are counted, and how plain-text links are tracked.
 *
 *   MASTER_KEY_B64=$(openssl rand -base64 32) npx tsx src/scripts/verify-rolling.ts
 */
import { CHECKPOINT_PLAN_WAIT_MS, CTA_TEXTS, TRIAL_CTA, planPriceFigures, LEAD_TYPE_PROFILES, avoidedWord, screenWords, unprovenClaims, checkpoint, clickedRecently, companyTokens, emojiProneSymbols, paceBand, leadTypeOf, longSentences, groupFor, isRolling, isRollingPlan, layoutArm, spelledQuantities, teamBand, themeSlug, unlabelledNumbers, watchWindowMs } from "../engine/rolling";
import { crossChannelGap } from "../engine/cadence";
import { readTemp } from "../engine/temp";
import { applyTextTracking } from "../engine/tracking";
import { plain, renderTemplate, resolveBlocks } from "../engine/compose";
import { renderHtml, renderLetter } from "../engine/html";
import { expandShortUnsubscribe, shortUnsubscribeUrl } from "../engine/unsubscribe";
import { DEFAULT_KIT } from "../engine/brand";
import { heardWords, newsSincePlan, saidText, sinceLastPlan, staleReason } from "../engine/news";
import { rankIdeas, saidScores } from "../engine/ideas";
import { chooseVariant } from "../engine/templates";

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

console.log("lead types");
check("hot campaign read from the goal", leadTypeOf({ leadType: "hot" }) === "hot");
check("unknown lead type ignored", leadTypeOf({ leadType: "lukewarm" }) === null && leadTypeOf(null) === null);
const lead = (temp?: { band?: string; by?: string }, timeline?: string) => ({ temp, enrichment: { form: { timeline } } });
check("the campaign's lead type paces, whatever their old score said", paceBand(lead({ band: "cold", by: "campaign" }), { leadType: "hot" }) === "hot");
check("a warm campaign paces warm even for a person read hot by another campaign", paceBand(lead({ band: "hot", by: "campaign" }), { leadType: "warm" }) === "warm");
check("'just exploring' in a hot campaign is paced warm", paceBand(lead(undefined, "just_exploring"), { leadType: "hot" }) === "warm");
check("a click makes anyone hot, an explorer too", paceBand(lead({ band: "hot", by: "click" }, "just_exploring"), { leadType: "cold" }) === "hot");
check("silence stops them in every campaign", paceBand(lead({ band: "dead", by: "silence" }), { leadType: "hot" }) === "dead");
check("no lead type, no pace", paceBand(lead({ band: "warm", by: "campaign" }), {}) === undefined);
check("only a click counts as clicked", clickedRecently(lead({ band: "hot", by: "click" })) && !clickedRecently(lead({ band: "hot", by: "campaign" })));
check("hot leads get email and WhatsApp 15 minutes apart", crossChannelGap(paceBand(lead(), { leadType: "hot" })).ms === 15 * 60_000);
check("warm leads keep 2 hours between channels", crossChannelGap(paceBand(lead(), { leadType: "warm" })).ms === 2 * H);
check("cold leads keep a day between channels", crossChannelGap(paceBand(lead(), { leadType: "cold" })).ms === 24 * H);
check("no band and dead keep the old 2 hours", crossChannelGap(undefined).ms === 2 * H && crossChannelGap("dead").ms === 2 * H);

console.log("temperature");
{
  const base = { trackableSends: 2, clicks: 0, silenceDays: 30, now, lastContactedAt: ago(24) };
  const two = [{ key: "july_aug", band: "warm" }, { key: "v3", band: "hot" }];
  const r = readTemp({ ...base, campaigns: two });
  check("the warmest running campaign sets the band", r.band === "hot" && r.by === "campaign" && r.campaign === "v3");
  check("a click in the last three weeks makes them hot", readTemp({ ...base, clicks: 1, lastClickAt: ago(20 * 24), campaigns: [{ key: "uk", band: "cold" }] }).by === "click");
  check("an old click is history", readTemp({ ...base, clicks: 1, lastClickAt: ago(22 * 24), campaigns: [{ key: "uk", band: "cold" }] }).band === "cold");
  check("silence past the limit stops them", readTemp({ ...base, lastContactedAt: ago(31 * 24), campaigns: two }).band === "dead");
  check("untracked mail proves no silence", readTemp({ ...base, trackableSends: 0, lastContactedAt: ago(31 * 24), campaigns: two }).by === "campaign");
  check("no running campaign, no band", readTemp({ ...base, campaigns: [] }).band === undefined);
}
check("hot email watched 24 h: 30 h after send asks", checkpoint({ now, lastSentAt: ago(30), lastChannel: "email", askedAt: ago(40), planWrittenAt: ago(39), leadType: "hot" }).kind === "ask");
check("the same without a lead type still watches (48 h)", checkpoint({ now, lastSentAt: ago(30), lastChannel: "email", askedAt: ago(40), planWrittenAt: ago(39) }).kind === "watch");
check("hot asks for the link, closing hook may ask for a reply", LEAD_TYPE_PROFILES.hot.ask === "link" && LEAD_TYPE_PROFILES.hot.replyHooks.includes("closing"));
check("warm follows up with the same short selling email, paced warm", LEAD_TYPE_PROFILES.warm.reveal === true && LEAD_TYPE_PROFILES.warm.band === "warm" && LEAD_TYPE_PROFILES.warm.sequence === LEAD_TYPE_PROFILES.hot.sequence && LEAD_TYPE_PROFILES.warm.maxWords === 75);
check("warm keeps a reply ask for a short question", LEAD_TYPE_PROFILES.warm.replyHooks.includes("question"));

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
  { type: "slot", name: "reveal", instruct: "" },
  { type: "list", slot: "shows", style: "check" },
  { type: "list", slot: "receipt", style: "receipt" },
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
check("letter with no brand: no logo, header or signature", !/<img|<table/.test(letter));
check("letter: white page and dark text, never a dark-capable colour scheme", letter.includes('content="light"') && !letter.includes("light dark") && letter.includes("color:#202124"));
check("letter: cost as a line and an arrow", letter.includes("₹4 lakh order<br />&rarr; <strong>5 days lost</strong>"));
check("letter: the call to action is one button", (letter.match(/display:inline-block;background:/g) ?? []).length === 1 && letter.includes("Start your free trial &rarr;</a>"));
{
  const branded = renderLetter(
    resolveBlocks(frame as never, mv, {
      slotText: "Scene.",
      slots: { opening: "**Open.**", question: "**Setup takes about 5 minutes.**", ps: "P.S. Reply call." },
      parts: { shows: { title: "TeamGrid shows how your team spends its day. You would see:", items: ["each hour", "what moved"] } },
    } as never),
    { name: "TeamGrid", logoUrl: "https://teamgrid.ai/logo.png", accent: "#28b4ae", tagline: "See how your team spends its working day.", website: "https://teamgrid.ai" },
  );
  const imgs = branded.match(/<img /g) ?? [];
  check("branded letter: logo on top and in the signature only", imgs.length === 2 && branded.indexOf("<img") < branded.indexOf("Hi Asha"));
  const section = branded.slice(branded.indexOf("border-top:1px solid #e5e7eb"), branded.indexOf("border-top:1px solid #e5e7eb") + 900);
  check("branded letter: the product part sits between thin lines, name in the accent shade, no logo", section.includes("border-bottom:1px solid #e5e7eb") && /<strong style="color:#[0-9a-f]{6};">TeamGrid<\/strong> shows/.test(section) && !section.includes("<img"));
  check("branded letter: accent ticks", section.includes('color:#28b4ae;font-weight:700;">&#10003;'));
  const ink = /display:inline-block;background:(#[0-9a-f]{6})/.exec(branded)?.[1] ?? "";
  check("branded letter: button dark enough for white text", ink !== "" && ink !== "#28b4ae");
  check("branded letter: signature after the sign-off, before the opt-out", branded.indexOf("Best regards") < branded.indexOf("See how your team spends its working day.") && branded.indexOf("See how your team spends its working day.") < branded.indexOf("Not useful?") && branded.includes(">teamgrid.ai</a>"));
  const withPs = renderLetter(
    { blocks: [{ kind: "text", text: "Best regards,\nThe TeamGrid Team" }, { kind: "text", text: "P.S. Reply call." }, { kind: "optout", url: "https://u.example/x" }] } as never,
    { name: "TeamGrid", accent: "#28b4ae", tagline: "Line." },
  );
  check("branded letter: signature sits before the P.S. and only once", withPs.indexOf("Line.") < withPs.indexOf("P.S. Reply call.") && withPs.split("Line.").length === 2);
}
check("letter: opt-out invites a reply", letter.includes('Reply "remove me", or <a href="https://u.example/api/u/long?s=abc" style="color:#5f6368;">unsubscribe</a>'));

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

console.log("plain language");
check("a short sentence passes", longSentences("A quote often needs one manager to approve it. When that manager is busy, the order waits.").length === 0);
check("a sentence over 20 words is caught", longSentences("In the weeks before rabi sowing dealer orders and service tickets pile up and many of them wait on one engineer to approve.").length === 1);
check("bold marks do not count as words", longSentences("**Twenty** words is fine here.").length === 0);
const plainList = [{ word: "sign-off", use: "approval" }, { word: "blocked", use: "stuck" }];
check("a hard word is caught with its plain one", avoidedWord("Which sign-off holds orders?", plainList)?.use === "approval");
check("plural and bold forms too", avoidedWord("two **sign-offs** today", plainList)?.word === "sign-off");
check("part of a longer word is not", avoidedWord("the unblockedness", plainList) === null);

console.log("reveal emails");
{
  const reveal = {
    slotText: "Picture a normal Tuesday at 2:15pm.",
    slots: { opening: "**Open.**", question: "**5 minutes per computer. 7 days. No card.**", limit: "No screenshots. Nothing people type is recorded.", cta_text: "See the first day" },
    parts: { receipt: { title: "A sample hour in TeamGrid:", items: ["14:00–15:00 · score 40%", "meetings in blue · idle in grey"] } },
  };
  const text = renderTemplate(frame, mv, reveal as never);
  check("receipt in plain text: title, then aligned lines with no marker", text.bodyMd.includes("A sample hour in TeamGrid:\n  14:00–15:00 · score 40%\n  meetings in blue · idle in grey"));
  check("button words come from cta_text", text.bodyMd.includes("See the first day: https://t.example/x"));
  const branded = renderLetter(resolveBlocks(frame as never, mv, reveal as never), { name: "TeamGrid", accent: "#28b4ae" });
  check("receipt in a letter: a bordered card in the body font between the thin lines", branded.includes("border-radius:10px;border-collapse:separate") && !branded.includes("monospace") && branded.indexOf("border-top:1px solid #e5e7eb") < branded.indexOf("border-radius:10px;border-collapse:separate"));
  check("the card's title is its small header", branded.includes("SAMPLE HOUR IN TEAMGRID") && !branded.includes("A sample hour in TeamGrid:"));
  check("sample card carries no colour words' colours", !branded.includes("#2563eb") && !branded.includes("#80868b"));
  check("button carries the reveal words", branded.includes("See the first day &rarr;</a>"));
  check("every email stays short: about 50 words, never more than 75", Object.values(LEAD_TYPE_PROFILES).every((p) => p.maxWords === 75) && LEAD_TYPE_PROFILES.hot.reveal === true);
  check("the plan prices are read from the facts", planPriceFigures({ plans: [{ price: "₹299 per user per month" }, { price: "₹649 per user per month" }, { price: "Custom, annual billing" }] }).join(",") === "₹299,₹649");
  check("every link button says where it goes", CTA_TEXTS[0] === TRIAL_CTA && !CTA_TEXTS.some((c) => /^See (the first day|your|who|where|tomorrow)/.test(c)));
  check("hot and warm rules sell with the price and a call offer", [LEAD_TYPE_PROFILES.hot, LEAD_TYPE_PROFILES.warm].every((p) => p.rules.some((r) => r.includes("writing.facts.plans")) && p.rules.some((r) => r.includes("P.S. Reply"))));
  check("sentences stay at 16 words or fewer", longSentences("Some clients take much more of your team's time than they pay for every single month.").length === 0 && longSentences("Some clients take much more of your team's time than they pay for, and most firms find out late.").length === 1);
  check("hot hooks start with the daily question and end on the closing note", LEAD_TYPE_PROFILES.hot.sequence?.[0]?.hook === "daily_question" && LEAD_TYPE_PROFILES.hot.sequence?.at(-1)?.hook === "closing");
  const noWay = {
    slotText: "Here is the funny part. The update already exists.",
    slots: { opening: "**Your team spends the morning answering any update?**", reveal: "TeamGrid writes it for you. By 6pm, one short summary per person.", limit: "No screenshots. Nothing people type is recorded.", question: "**You can finally retire the question.**", cta_text: "See tomorrow's 6pm summary" },
  };
  const noWayText = renderTemplate(frame, mv, noWay as never);
  check("reveal reads as its own paragraph in plain text", noWayText.bodyMd.includes("The update already exists.\n\nTeamGrid writes it for you. By 6pm, one short summary per person.\n\nNo screenshots."));
  const noWayLetter = renderLetter(resolveBlocks(frame as never, mv, noWay as never), { name: "TeamGrid", accent: "#28b4ae" });
  const at = noWayLetter.indexOf("border-top:1px solid #e5e7eb");
  check("reveal sits between thin lines in a letter, name in the brand shade", at > 0 && /<strong style="color:#[0-9a-f]{6};">TeamGrid<\/strong> writes it for you/.test(noWayLetter.slice(at, at + 600)));
  check("reveal button words", noWayLetter.includes("See tomorrow&#39;s 6pm summary &rarr;") || noWayLetter.includes("See tomorrow's 6pm summary &rarr;"));
  check("screen words caught", screenWords("Teal is focus. Meetings in blue, idle in grey on the dashboard.").length === 4 && screenWords("By 6pm, one short summary per person.").length === 0);
  check("an invented testimonial is caught", unprovenClaims("Founders who install this do not say nice dashboard. They say wow.").length > 0);
  check("customers say is caught", unprovenClaims("Customers love how simple it is.").length > 0);
  check("caught and wasting are caught", unprovenClaims("We caught them wasting the afternoon.").length === 2);
  check("a plain product line is not", unprovenClaims("TeamGrid shows each hour of the day, and the apps behind it.").length === 0);
}

console.log("idea bank");
{
  const { rankIdeas } = await import("../engine/ideas");
  const bank = [
    { n: 7, title: "The 8 PM status calls", hook: "daily_question", proof: "6pm summary", keywords: ["update", "calls", "evening"], segments: ["founder"] },
    { n: 71, title: "Forty forgot to punch requests a month", hook: "office_habit", proof: "attendance from activity", keywords: ["attendance", "punch", "biometric", "payroll"], segments: ["hr_ops"] },
    { n: 20, title: "A manufacturer case", hook: "hidden_bill", proof: "none", keywords: ["attendance"], usable: false },
  ];
  const hr = rankIdeas(bank, { text: "Attendance and payroll disputes every month, biometric punch misses", segment: "hr_ops" }, new Map(), new Set());
  check("an HR lead with punch problems gets the punch idea first", hr[0]?.n === 71);
  check("an unusable idea is never offered", !hr.some((i) => i.n === 20));
  const busy = rankIdeas(bank, { text: "Attendance and payroll disputes, biometric punch", segment: "hr_ops" }, new Map([[71, 6]]), new Set());
  check("an idea many leads got this week drops down", busy[0]?.n === 7);
  const had = rankIdeas(bank, { text: "Attendance punch biometric payroll", segment: "hr_ops" }, new Map(), new Set([71]));
  check("an idea the lead already had goes last", had.at(-1)?.n === 71 && had.at(-1)?.already_had === true);
  const { ideaLimits } = await import("../engine/ideas");
  check("a campaign of 56 keeps the cap of 5", ideaLimits(56, 50).cap === 5 && ideaLimits(56, 50).busyAt === 3);
  const big = ideaLimits(332, 50);
  check("a campaign of 332 on 50 ideas can plan every lead", big.cap * 50 >= 332 * 2 && big.busyAt < big.cap);
  const roomy = rankIdeas(bank, { text: "Attendance and payroll disputes, biometric punch", segment: "hr_ops" }, new Map([[71, 6]]), new Set(), big);
  check("in a big campaign 6 uses is not yet busy", roomy[0]?.n === 71);

  const { ideaRecords, recordScore, ideasFor, nextInventedN, loserSends, RECORD_LOSER_SENDS } = await import("../engine/ideas");
  const row = (n: number, group: string, sent: number, clicked: number, replied = 0) => ({ n, group, sent, trackable: sent, opened: 0, clicked, replied, won: 0, lastSentAt: null });
  const recs = ideaRecords([row(7, "founder|11-50", 20, 4), row(71, "founder|11-50", 20, 0), row(71, "hr_ops|51-200", 20, 0), row(5, "founder|11-50", 3, 1)], "founder|11-50");
  check("an idea that earns clicks in the lead's group rises", recordScore(7, recs) > 0);
  check("an idea with few sends gets the untested push", recordScore(5, recs) === 1 && recordScore(99, recs) === 1);
  check("an idea with nothing back after the loser mark sinks", recordScore(71, ideaRecords([row(71, "g", RECORD_LOSER_SENDS, 0), row(7, "g", 20, 4)], "g")) === -20);
  check("at a 2% response rate the loser mark waits for about 114 sends", loserSends(0.02) === 114 && loserSends(0) === RECORD_LOSER_SENDS);
  check("30 silent sends at 2% are bad luck, not a loser", recordScore(71, ideaRecords([row(71, "g", 30, 0), row(7, "g", 170, 4)], "g")) > -20);
  const ranked = rankIdeas(bank, { text: "Attendance and payroll disputes every month, biometric punch misses", segment: "hr_ops" }, new Map(), new Set(), undefined, ideaRecords([row(71, "hr_ops|51-200", RECORD_LOSER_SENDS, 0), row(7, "hr_ops|51-200", 20, 4)], "hr_ops|51-200"));
  check("results can outrank keyword fit", ranked[0]?.n === 7 && Boolean(ranked[0]?.record));
  const productWithInvented = { config: { writing: { ideas: bank, invented: [{ n: 1001, title: "Invented", hook: "office_habit", proof: "x", status: "trial", source: "claude" }, { n: 1002, title: "Gone", hook: "office_habit", proof: "x", status: "retired", source: "claude" }] } } };
  check("invented ideas stay out when the loop is off", !ideasFor(productWithInvented, false).some((i) => i.n >= 1001));
  check("the loop adds invented ideas still in play", ideasFor(productWithInvented, true).some((i) => i.n === 1001) && !ideasFor(productWithInvented, true).some((i) => i.n === 1002));
  const { IDEAS_ARE_TEACHING } = await import("../engine/rolling");
  check("hot and warm rules teach the bank as patterns, not a menu", [LEAD_TYPE_PROFILES.hot, LEAD_TYPE_PROFILES.warm].every((p) => p.rules.some((r) => r.includes(IDEAS_ARE_TEACHING))));
  const shaped = rankIdeas([...bank, { n: 41, title: "Chat open all day", hook: "office_habit", proof: "app time", also: ["Customer chats on WhatsApp Web from 10 to 7"] }], { text: "our team answers customers on whatsapp all day" }, new Map(), new Set());
  check("an idea's other shapes count when matching a lead", shaped[0]?.n === 41);
  check("invented ideas are numbered from 1001", nextInventedN([]) === 1001 && nextInventedN([{ n: 1004 } as never]) === 1005);
  const withCard = renderLetter(
    resolveBlocks(frame as never, mv, {
      slotText: "Scene.",
      slots: { opening: "**Open.**", reveal: "By 6pm, TeamGrid writes what each desk did today.", limit: "No screenshots. Nothing people type is recorded.", question: "**Close.**" },
      parts: { receipt: { title: "A sample 6pm summary:", items: ["Operations · 6h 40m tracked · 4.2h focus", "Shipped: 214 order lines reconciled"] } },
    } as never),
    { name: "TeamGrid", accent: "#28b4ae" },
  );
  const sections = withCard.split("padding:12px 0;border-top:1px solid #e5e7eb").length - 1;
  check("the sample card sits inside the reveal section, not a second one", sections === 1 && withCard.indexOf("writes what each desk") < withCard.indexOf("SAMPLE 6PM SUMMARY · OPERATIONS") && withCard.indexOf("SAMPLE 6PM SUMMARY · OPERATIONS") < withCard.indexOf("214 order lines"));
  check("a summary card leads with its 2 figures", withCard.includes(">6h 40m</div>") && withCard.includes(">4.2h</div>"));
}

console.log("sample card layout");
{
  const { sampleRows } = await import("../engine/html");
  const kinds = (lines: string[]) => sampleRows(lines).map((r) => r.kind).join(",");
  check("apps read as bars and a total", kinds(["Excel · 4h 53m", "Chrome · 1h 22m", "Teams · 12m", "6h 27m active · 0m idle"]) === "bar,bar,bar,total");
  check("a tracked day reads as a time list", kinds(["09:04 standup · 18m", "12:18 break · paused on its own · 31m"]) === "timed,timed");
  const hour = sampleRows(["11:00–12:00 · 85%", "14:00–15:00 · score 40%"]);
  check("hourly scores read as bars labelled by the hour", hour[0]?.kind === "bar" && (hour[0] as { label: string }).label === "11–12" && (hour[1] as { amount: number }).amount === 40);
  check("a summary reads as figures and labelled rows", kinds(["Operations · 6h 40m tracked · 4.2h focus", "Done: 214 order lines reconciled", "Stuck: 1 task, opened again, week 4"]) === "headline,labelled,labelled");
  const break_ = sampleRows(["12:18 break · paused on its own · 31m"])[0] as { what: string; value: string };
  check("a time row keeps its words and its duration", break_.what === "Break, paused on its own" && break_.value === "31m");
}

console.log("sample card figures");
{
  const { unsampledFigures } = await import("../engine/rolling");
  const samples = ["Sample 6pm summary: Operations, 6h 40m tracked, 4.2h deep focus; shipped: 214 order lines reconciled; flag: one research task stalled again, week four.", "hourly scores 11:00–12:00 85%, 14:00–15:00 40%."];
  check("site figures pass with the nouns changed", unsampledFigures(["Accounts · 6h 40m tracked · 4.2h focus", "Done: 214 GST entries matched", "Stuck: 1 notice reply, week 4", "11:00–12:00 · 85%"], samples).length === 0);
  check("an invented figure is named", JSON.stringify(unsampledFigures(["Sales · 7h 10m tracked", "Done: 214 calls"], samples)) === JSON.stringify(["7h", "10m"]));
}

console.log("short unsubscribe link");
{
  const { validate } = await import("../engine/validate");
  const replyMail = renderTemplate(frame, { ...mv, opt_out_short_url: "https://app.example.com/u/aqjxxEDjLfqAP6N1.4c2J-6xEByV2" }, { subject: "How many of 9 hours are focused?", slotText: "Scene.", slots: { opening: "**Open.**", question: "**Which one?**" }, ask: "reply" });
  const verdict = validate({ ...replyMail, claimsMade: [] } as never, { channelKey: "email", ask: "reply", isReply: false, priorClaims: [] } as never);
  check("a reply ask with the short unsubscribe link passes validation", !verdict.hardFails.some((f: string) => f.includes("carries a link")));
  const withLink = validate({ ...replyMail, bodyMd: replyMail.bodyMd + "\nSee https://teamgrid.ai/pricing", claimsMade: [] } as never, { channelKey: "email", ask: "reply", isReply: false, priorClaims: [] } as never);
  check("a reply ask with any other link still fails", withLink.hardFails.some((f: string) => f.includes("carries a link")));
}
const personHex = "6aa8f1c440e32dfa803fa375";
const short = shortUnsubscribeUrl("https://app.example.com/", personHex)!;
check("short link is short", short.length < 60 && short.startsWith("https://app.example.com/u/"));
const expanded = expandShortUnsubscribe(short.split("/u/")[1]!);
check("expands to the full signed path", expanded !== null && expanded.startsWith(`/api/u/${personHex}?s=`));
check("a tampered code is refused", expandShortUnsubscribe(short.split("/u/")[1]!.replace(/.$/, (c) => (c === "A" ? "B" : "A"))) === null);
check("garbage is refused", expandShortUnsubscribe("nonsense") === null);

check("plain() drops bold and italics", plain("**a** and _b_.") === "a and b.");

console.log("news since the plan");
{
  const plannedAt = new Date("2026-09-21T11:17:43Z");
  check("no news → plan current", newsSincePlan({}, plannedAt) === null);
  check("news that reached us after the plan → stale", newsSincePlan({ newsAt: new Date("2026-09-21T12:01:17Z") }, plannedAt) !== null);
  check("news from before the plan → current", newsSincePlan({ newsAt: new Date("2026-09-21T10:00:00Z") }, plannedAt) === null);
  check("stale skip reads as a replaced plan, not a failure", /^plan replaced/.test(staleReason({ news: { source: "crm", what: "wants CRM" } })));
  // The sales note was written at 10:36, before the plan, but reached us at 12:01, after it.
  const crm = {
    enabled: true,
    records: [],
    activity: [
      { at: new Date("2026-09-21T10:36:50Z"), knownAt: new Date("2026-09-21T12:01:17Z"), kind: "note" as const, type: "NOTE", text: "Demo is completed and he is more interested to purchase CRM, and we have offered free trial for 3 users.", recordId: "r", review: false },
      { at: new Date("2026-09-21T10:36:57Z"), knownAt: new Date("2026-09-21T12:01:17Z"), kind: "followup" as const, type: "FOLLOWUP", text: "scheduled follow-up", recordId: "r", review: false },
      { at: new Date("2026-09-18T09:17:13Z"), knownAt: new Date("2026-09-18T09:30:00Z"), kind: "meeting_booked" as const, type: "MEETING", recordId: "r", review: false },
    ],
  };
  const since = sinceLastPlan({ planWrittenAt: plannedAt, crm, actions: [{ channel: "email", content: { subject: "One team, 7 days" }, firstOpenedAt: new Date("2026-09-21T12:14:53Z") }], events: [] });
  check("a note written before the plan but synced after it is news", since?.items.some((i) => i.what.includes("purchase CRM")) === true);
  check("follow-up admin is not news", since?.items.every((i) => !i.what.includes("scheduled follow-up")) === true);
  check("history the plan already had is left out", since?.items.every((i) => !i.from.includes("meeting_booked")) === true);
  check("our own opens since the plan are listed", since?.items.some((i) => i.what.startsWith("opened")) === true);
  check("deal talk is not a need: only CRM is heard", [...heardWords(crm.activity[0]!.text)].join(",") === "crm");
  const bank = [
    { n: 1, title: "Evening calls", hook: "daily_question", proof: "Written end-of-day summary by 6pm" },
    { n: 2, title: "Deals that went quiet", hook: "found_out_late", proof: "CRM that logs activity automatically and alerts when a lead or deal goes quiet." },
    { n: 3, title: "Setup", hook: "setup", proof: "7-day trial with no card, free" },
  ];
  const ranked = rankIdeas(bank, { text: "Results KPIs pipeline", said: saidText(crm, undefined), segment: "founder" }, new Map(), new Set());
  check("what they told the sales team lifts the CRM idea to the top", ranked[0]!.n === 2);
  check("'free trial' in a note lifts no setup idea", (saidScores(bank, saidText(crm, undefined)).get(3) ?? 0) === 0);
  const variants = [
    { key: "hours", family: "f", name: "Hours by project", blocks: [{ fallback: "See where the hours go" }] },
    { key: "crm", family: "f", name: "Deals that go quiet", blocks: [{ fallback: "The CRM alerts you when a deal goes quiet" }] },
  ];
  check("a fallback variant about what they asked for goes first", chooseVariant(variants, { family: "f", interest: "more interested to purchase CRM", rnd: () => 0.99 })?.key === "crm");
  check("no interest → statistics decide as before", chooseVariant(variants, { family: "f", rnd: () => 0.5 }) !== null);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
