import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import {
  FRAME_BODY_MAX_WORDS, OPENING_MAX_CHARS, SCENE_KINDS, avoidedWord, carriesTheirWorld,
  companyTokens, emojiProneSymbols, longSentences, planPriceFigures, priceHistory, repeatedSentence, scenesSent,
  screenWords, spelledQuantities, theirWords, unprovenClaims,
} from "../engine/rolling.js";

/**
 * The mails waiting in Review for teamgrid_leads_v3 on 2026-09-28, rewritten to the rules that
 * came in that day: a scene that is not the shape their last mail used, rupees only in a money
 * scene, the hour rate written as our assumption, the price in one mail of three, nothing
 * repeated word for word from a mail they have already had, and a subject and a reveal built
 * from their own trade.
 *
 * A one-off batch, kept in the repo because it is what went back into Review and why. It touches
 * only the action ids below, only while each is still awaiting_approval, and it writes words: it
 * never sends, approves or removes anything. Every mail is checked against the same rules
 * compose_batch enforces, and one that fails any of them is reported and left exactly as it was.
 *
 *   npm run rewrite:review              check them and write nothing
 *   npm run rewrite:review -- --apply   write the ones that pass
 */

interface Draft {
  id: string; kind: "money" | "moment" | "shown"; subject: string; opening: string; scene: string;
  reveal?: string; question: string; ps?: string; ask?: "link" | "reply"; format?: string;
}

const PS = 'Reply "call" and we will call you.';

const DRAFTS: Draft[] = [
  { id: "6ab51d1f25db026c9bc57971", kind: "money", subject: "Site round at Heaven Solar",
    opening: "Every evening someone calls each site to hear where things stand.",
    scene: "Suppose the evening round takes 45 minutes a day. Over a month that is **16 hours**. If an hour costs ₹300, about **₹4,800**.",
    reveal: "TeamGrid is a small app on your office computers. It also shows whose paperwork is still waiting at 6pm.",
    question: "₹299 per person a month. No card needed to try.", ps: PS },

  { id: "6ab8b58e45e3d1a03e4b16e5", kind: "shown", subject: "Where the planning day went",
    opening: "A day of client calls ends, and nobody can say where the hours went.",
    scene: "Tuesday: 2 hours on one insurance file, and nothing on the new goals.",
    reveal: "TeamGrid also shows which insurance file took the day, and nobody fills a sheet.",
    question: "Which client file would you want that on first?", ps: PS },

  { id: "6ab8b58e45e3d1a03e4b16e7", kind: "moment", subject: "Nobody is watched at Instabiz",
    opening: "A new app on office computers worries the team before anyone explains it.",
    scene: "Someone asks whether screenshots are taken. Nobody wants to be the one who asked.",
    reveal: "TeamGrid takes no screenshots, records nothing anyone types, and each person sees their own day.",
    question: "Would the team be easier about it if they saw their own day?", ps: PS },

  { id: "6ab8b5b145e3d1a03e4b16f6", kind: "moment", subject: "The evening simulator call",
    opening: "Every evening the build team is called to ask what moved today.",
    scene: "Monday the simulation model waits on one engineer. The call finds out on Wednesday.",
    reveal: "TeamGrid also writes what moved on the model by 6pm. The call has nothing left to ask.",
    question: "Would that note replace the evening call this week?", ps: PS },

  { id: "6ab8b5b445e3d1a03e4b16f8", kind: "moment", subject: "About your corporate rides", ask: "reply", format: "text",
    opening: "We have written a few times about the desk hours behind each ride.",
    scene: "A chauffeur booking is confirmed by phone, and the desk time behind it is never counted.",
    question: "Should we close this, or would a 15-minute call help?" },

  { id: "6ab8b5c645e3d1a03e4b1706", kind: "moment", subject: "A question for the owner", ask: "reply", format: "text",
    opening: "Design seats renew every month whether anyone opens them or not.",
    scene: "A licence renews on the 1st. Nobody checks who opened it last month.",
    question: "Should we keep this open, or close it here?" },

  { id: "6ab8b5e645e3d1a03e4b1712", kind: "shown", subject: "What the security team runs",
    opening: "Each team has its own tools, and nobody has the full list.",
    scene: "Tuesday: the security team spent the morning in 2 apps, and the web team in another.",
    reveal: "TeamGrid also lists which apps the security team really uses, without asking anyone.",
    question: "Which team's list would you want first?", ps: PS },

  { id: "6ab8b5f345e3d1a03e4b1717", kind: "moment", subject: "The counselling call that waited",
    opening: "A parent asks about admission, and the callback happens 3 days later.",
    scene: "Monday the question comes in. Thursday someone remembers, and the family has already enrolled elsewhere.",
    reveal: "TeamGrid also shows which counselling call got no reply today.",
    question: "Which one would you want flagged first?", ps: PS },

  { id: "6ab8b63245e3d1a03e4b172b", kind: "shown", subject: "The gases billing desk",
    opening: "The day splits between the billing desk and the tankers going out.",
    scene: "Tuesday: 6 hours of desk work on medical gas orders, and the rest at the plant.",
    reveal: "TeamGrid also shows how much of the week the medical gas orders really take.",
    question: "Would that split be worth seeing for a week?", ps: PS },

  { id: "6ab8c3c545e3d1a03e4b18c8", kind: "money", subject: "The hour between sessions",
    opening: "Between 2 client sessions, an hour goes somewhere nobody can name.",
    scene: "Suppose 30 minutes slip between sessions each day. Over a month that is **11 hours**. If an hour costs ₹200, about **₹2,200**.",
    reveal: "TeamGrid also shows what filled the gap between 2 sessions.",
    question: "Would seeing one week of those gaps help?", ps: PS },

  { id: "6ab8c3e045e3d1a03e4b18d6", kind: "shown", subject: "The crew's best activation hour",
    opening: "Client review calls tend to land on the crew's sharpest hour.",
    scene: "Tuesday: the strongest stretch went to a review call, not the activation work.",
    reveal: "TeamGrid also shows which hour each installation crew works best, so calls can move.",
    question: "Would you move one review call this week?", ps: PS },

  { id: "6ab8c3f4d67f616fb997b8d5", kind: "money", subject: "Before the next hire",
    opening: "2 more people are approved before anyone knows how the work is spread.",
    scene: "Suppose 3 of 30 people carry double the load. 2 hires at about ₹6 lakh a year is **₹12 lakh**.",
    reveal: "TeamGrid also shows how the work is really spread, so the outcomes decide the headcount.",
    question: "Which team would you check before hiring?", ps: PS },

  { id: "6ab8c3fed67f616fb997b8db", kind: "shown", subject: "The drawing office hour",
    opening: "Not every hour of the drawing office day is the same.",
    scene: "Tuesday: the cable schedule moved in one hour, and the rest went to calls.",
    reveal: "TeamGrid also scores each hour, so the cable work and the calls are told apart.",
    question: "Would you want to see one week of that?", ps: PS },

  { id: "6ab8c40ad67f616fb997b8df", kind: "moment", subject: "Who showed the veneer today",
    opening: "Nobody writes down who showed which customer around the floor.",
    scene: "A buyer asks for the laminates range again. 2 people answer, and neither knows who saw them first.",
    reveal: "TeamGrid also shows who walked the buyer through the laminates, without a sheet.",
    question: "Would that help at the month's review?", ps: PS },

  { id: "6ab8c422d67f616fb997b8e7", kind: "shown", subject: "Who carries the parts desk",
    opening: "2 or 3 people quietly carry the rest of the team.",
    scene: "Tuesday: the same person handled the spindle repair and the parts orders.",
    reveal: "TeamGrid also shows how the parts work is spread, before anyone burns out.",
    question: "Would you want that list before the next month?", ps: PS },

  { id: "6ab8c430d67f616fb997b8ed", kind: "shown", subject: "Hours before the next brand",
    opening: "A new client is taken on before anyone counts the hours left.",
    scene: "Tuesday: the drone edit took the morning, and 2 brands waited.",
    reveal: "TeamGrid also shows how many focused hours each brand really takes.",
    question: "Would you check that before the next yes?", ps: PS },

  { id: "6ab8c430d67f616fb997b8ef", kind: "moment", subject: "Start with the export desk", ask: "reply", format: "text",
    opening: "The whole floor does not have to decide this at once.",
    scene: "The export desk alone, for one week: the rotavator orders, and nothing else changes.",
    question: "Would the export desk be the place to start?" },

  { id: "6ab8c43dd67f616fb997b8f4", kind: "moment", subject: "Evening calls at Meghmani Life",
    opening: "Every evening the founder calls each person for an update.",
    scene: "The calls run past dinner, and most answers are still working on it.",
    reveal: "TeamGrid also writes each person's day by 6pm, so the calls have nothing left to ask.",
    question: "Would that note replace tonight's calls?", ps: PS },

  { id: "6ab8c450d67f616fb997b8f9", kind: "shown", subject: "Late nights nobody flagged",
    opening: "As the owner, you hear about the late nights weeks after they start.",
    scene: "Tuesday: 2 people worked past 9pm, and nobody raised it.",
    reveal: "TeamGrid also flags the week someone worked past 9pm, not months later.",
    question: "Would you want that flag this week?", ps: PS },

  { id: "6ab8c451d67f616fb997b8fb", kind: "money", subject: "The exhibition revision calls",
    opening: "Revision calls from clients and vendors fill a coordinator's best hours.",
    scene: "Suppose 2 coordinators lose 90 minutes a day to those calls. Over a month that is **66 hours**. If an hour costs ₹200, about **₹13,200**.",
    reveal: "TeamGrid also shows which exhibition ate the coordinator's week.",
    question: "Would one week of that be worth seeing?", ps: PS },

  { id: "6ab8c466d67f616fb997b902", kind: "moment", subject: "Facts the timber desk sees",
    opening: "A pay talk built on memory feels unfair to the person across the desk.",
    scene: "The month a buyer's order ran long is remembered. The quiet months are not.",
    reveal: "TeamGrid shows the last 12 weeks of the timber desk to both of you. Nothing anyone types is recorded.",
    question: "Would that make the next pay talk easier?", ps: PS },
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = await getDb();
  console.log(`database ${db.databaseName}\n`);
  const product = await db.collection(C.products).findOne({ _id: new ObjectId("6a964454c4fa12977b6d6964") }, { projection: { config: 1 } });
  const writing = ((product?.config as { writing?: Record<string, unknown> } | null)?.writing ?? {}) as Record<string, unknown>;
  const prices = planPriceFigures(writing.facts);
  const wordsAvoid = ((writing.wordsAvoid as Array<{ word: string; use: string }> | undefined) ?? []).filter((w) => w?.word);
  const subjectAvoid = ((writing.subjectAvoid as string[] | undefined) ?? []).map(String);

  let refused = 0;
  const ready: Draft[] = [];
  for (const d of DRAFTS) {
    const action = await db.collection(C.actions).findOne({ _id: new ObjectId(d.id) });
    if (!action) { console.log(`${d.id}: no longer in the queue, skipped`); continue; }
    if (String(action.status) !== "awaiting_approval") { console.log(`${d.id}: now ${String(action.status)}, skipped`); continue; }
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
    const prior = await db.collection(C.actions).find({ goalInstanceId: String(action.goalInstanceId), status: { $in: ["sent", "dispatched"] } }).toArray();
    const price = priceHistory(prior, prices);
    const theirs = theirWords(person);
    const ask = d.ask ?? "link";
    const parts = [d.opening, d.scene, d.reveal ?? "", d.question].filter(Boolean);
    const words = parts.join(" ").split(/\s+/).filter(Boolean).length + (d.ps ? d.ps.split(/\s+/).filter(Boolean).length : 0);
    const written = [d.subject, d.opening, d.scene, d.reveal ?? "", d.question, d.ps ?? ""].join("\n").replace(/₹\s+/g, "₹");
    const sceneText = [d.subject, d.opening, d.scene, d.reveal ?? ""].join("\n").replace(/₹\s+/g, "₹");
    const f: string[] = [];

    if (d.kind === scenesSent(prior).last) f.push(`scene repeats their last (${d.kind})`);
    if (!(SCENE_KINDS as readonly string[]).includes(d.kind)) f.push("unknown scene kind");
    const rupees = d.kind !== "money" ? sceneText.match(/₹\s?[\d,]+/g) ?? [] : [];
    if (rupees.length) f.push(`"${d.kind}" scene carries ${rupees[0]}`);
    if (/(?:^|[^a-z])(?:at|@)\s*₹\s?[\d,]+\s*(?:an|per|\/)\s*hour/i.test(written)) f.push("rate stated as a fact");
    const gave = prices.filter((p) => written.includes(p));
    if (price.due && ask === "link" && gave.length === 0) f.push("price due and missing");
    if (!price.due && gave.length) f.push(`price again (${gave[0]}), ${price.mails_ago} mail(s) ago`);
    if (theirs.length && !carriesTheirWorld([d.subject, d.opening, d.scene, d.reveal ?? ""].join("\n"), theirs)) {
      f.push(`nothing of theirs (${theirs.slice(0, 5).join(", ")})`);
    }
    if (d.reveal) {
      const nouns = [...new Set(d.scene.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? [])];
      if (!carriesTheirWorld(d.reveal, [...theirs, ...nouns])) f.push("reveal says nothing about the scene");
    }
    const twice = repeatedSentence([d.opening, d.scene, d.reveal ?? ""].join("\n"), prior);
    if (twice) f.push(`already sent: "${twice.slice(0, 40)}"`);
    if (words > FRAME_BODY_MAX_WORDS) f.push(`${words} words`);
    for (const s of longSentences(parts.join("\n"))) f.push(`long sentence: "${s.slice(0, 40)}"`);
    if (d.opening.length > OPENING_MAX_CHARS) f.push(`opening ${d.opening.length} characters`);
    if ((d.scene.match(/\*\*[^*]+\*\*/g) ?? []).length > 2) f.push("more than 2 bold phrases");
    const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9₹]+/g, " ").trim();
    if (squash(d.opening).includes(squash(d.subject))) f.push("opening repeats the subject");
    const subjectWords = d.subject.split(/\s+/).filter(Boolean).length;
    if (d.subject.length < 18 || d.subject.length > 45) f.push(`subject ${d.subject.length} characters`);
    if (subjectWords < 3 || subjectWords > 5) f.push(`subject ${subjectWords} words`);
    if (/[\d?:]/.test(d.subject)) f.push("subject has a digit or punctuation");
    for (const w of subjectAvoid) if (new RegExp(`\\b${w}\\b`, "i").test(d.subject)) f.push(`subject word "${w}"`);
    const hard = avoidedWord(parts.join("\n"), wordsAvoid);
    if (hard) f.push(`word "${hard.word}" (say "${hard.use}")`);
    if (screenWords(written).length) f.push(`screen word "${screenWords(written)[0]}"`);
    if (spelledQuantities(written).length) f.push(`spelled quantity "${spelledQuantities(written)[0]}"`);
    if (emojiProneSymbols(written).length) f.push("a symbol phones turn into an emoji");
    if (unprovenClaims(written).length) f.push(`claim "${unprovenClaims(written)[0]}"`);
    const inBody = [d.opening, d.scene, d.reveal ?? "", d.question, d.ps ?? ""].join("\n").toLowerCase();
    const named = companyTokens(person).find((t) => inBody.includes(t));
    if (named) f.push(`company name in the body ("${named}")`);
    if (ask === "reply" && !/\?\s*$/.test(d.question)) f.push("reply ask does not end on a question");

    console.log(`${d.id}  ${d.kind}${ask === "reply" ? " · reply" : ""}  ${words}w  "${d.subject}"`);
    console.log(f.length ? `  REFUSED: ${f.join(" | ")}` : "  ok");
    if (f.length) refused++; else ready.push(d);
  }

  console.log(`\n${ready.length} pass the rules, ${refused} refused.`);
  if (!apply) {
    console.log("Nothing written. Re-run with --apply to write the ones that pass.");
    return;
  }

  for (const d of ready) {
    const ask = d.ask ?? "link";
    const slots: Record<string, string> = { opening: `**${d.opening}**`, question: `**${d.question}**` };
    if (d.reveal) slots.reveal = d.reveal;
    if (d.ps) slots.ps = `P.S. ${d.ps}`;
    if (ask === "link") slots.cta_text = "Try it free for 7 days";
    await db.collection(C.actions).updateOne(
      { _id: new ObjectId(d.id), status: "awaiting_approval" },
      {
        $set: {
          sceneKind: d.kind,
          ...(d.format ? { format: d.format } : {}),
          "content.subject": d.subject,
          "content.slotText": d.scene,
          "content.slots": slots,
          "content.wordCount": [d.opening, d.scene, d.reveal ?? "", d.question].join(" ").split(/\s+/).filter(Boolean).length,
          "content.rewrittenAt": new Date(),
          ...(ask === "reply" ? { "content.ask": "reply" } : {}),
        },
        // Cleared so Review and the sender build the mail from these words, not the stored render.
        $unset: {
          "content.bodyMd": "", "content.bodyHtml": "", "content.preheader": "", "content.parts": "", validation: "",
          ...(ask === "link" ? { "content.ask": "" } : {}),
        },
      },
    );
  }
  console.log(`\nrewrote ${ready.length} mails. They stay in Review with the new words; nothing was sent.`);
  if (refused) console.log(`${refused} were left exactly as they were — their reasons are above.`);
}

void main().then(() => process.exit(0), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
