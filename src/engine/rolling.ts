import type { Document } from "mongodb";

/**
 * The rolling planner: plan the next one or two touches, watch what the person does, then
 * plan again.
 *
 * A plan written for a month before the first message has gone out is a guess about a
 * stranger, and every step after the first is written blind to the one thing that would
 * have changed it. So a campaign in rolling mode holds at most two steps at a time. When
 * they are spent, the engine waits out a watch window long enough for the last touch to be
 * answered, or less if they already answered it, and then asks for the next plan. Everything
 * here is a pure decision so the tick, the tools and the checks share one reading of it.
 *
 * See docs/rolling-planner.md.
 */

export const ROLLING_MAX_STEPS = 2;

/** How long a lead in rolling mode waits for a checkpoint plan before a fixed email goes instead. */
export const CHECKPOINT_PLAN_WAIT_MS = 12 * 3_600_000;

/** How long after asking before the same checkpoint is asked for again. */
export const CHECKPOINT_REASK_MS = 12 * 3_600_000;

/** The frame a written touch renders through when a campaign names none. */
export const DEFAULT_FRAME_KEY = "written_email";

/** Most words a session writes into the frame. The whole mail still stays under 200. */
export const FRAME_BODY_MAX_WORDS = 125;

/**
 * How long a touch is given to be answered before the next one is planned.
 *
 * Email is read over a day or two; a WhatsApp message within hours; a call has its answer
 * the moment it ends. A click or a reply ends any window at once.
 */
export const WATCH_WINDOW_MS: Record<string, number> = {
  email: 48 * 3_600_000,
  whatsapp: 24 * 3_600_000,
  sms: 24 * 3_600_000,
  voice: 2 * 3_600_000,
};

export function watchWindowMs(channel: string | undefined): number {
  return WATCH_WINDOW_MS[String(channel ?? "email")] ?? WATCH_WINDOW_MS.email!;
}

export interface PerLeadPlan {
  family?: string;
  mode?: string;
  frame?: string;
}

export function perLeadPlanOf(goal: Document | null | undefined): PerLeadPlan | null {
  const raw = goal?.perLeadPlan as PerLeadPlan | undefined;
  return raw && typeof raw === "object" ? raw : null;
}

export function isRolling(goal: Document | null | undefined): boolean {
  return perLeadPlanOf(goal)?.mode === "rolling";
}

export function frameKeyOf(goal: Document | null | undefined): string {
  return perLeadPlanOf(goal)?.frame || DEFAULT_FRAME_KEY;
}

/** A plan written for the rolling planner. Older plans read as spent once a campaign switches. */
export function isRollingPlan(plan: Document | null | undefined): boolean {
  return Boolean(plan && plan.rolling === true);
}

export interface CheckpointInput {
  /** When the most recent touch in this campaign went out, if any has. */
  lastSentAt?: Date | null;
  lastChannel?: string;
  /** The latest click or reply after that send, if any. */
  signalAt?: Date | null;
  /** When the engine last asked for a plan at a checkpoint. */
  askedAt?: Date | null;
  /** When the current plan was written. A plan written after the ask answers it. */
  planWrittenAt?: Date | null;
  now: Date;
  /** The campaign's lead type, which can shorten the watch window. */
  leadType?: LeadType | null;
}

export type CheckpointDecision =
  | { kind: "watch"; until: Date }
  | { kind: "ask"; reason: "window_closed" | "signal" | "nothing_sent" | "news" }
  | { kind: "waiting"; since: Date }
  | { kind: "fallback"; since: Date };

/**
 * What to do with a lead whose rolling plan is spent.
 *
 *   watch     the last touch still has time to be answered
 *   ask       queue a plan job now
 *   waiting   a plan was asked for and has not arrived; keep waiting
 *   fallback  it has not arrived in time; a fixed email goes instead
 */
export function checkpoint(input: CheckpointInput): CheckpointDecision {
  const now = input.now.getTime();
  const asked = input.askedAt ? input.askedAt.getTime() : null;
  const written = input.planWrittenAt ? input.planWrittenAt.getTime() : null;
  // An ask that a newer plan has not yet answered.
  const openAsk = asked !== null && (written === null || written < asked) ? asked : null;

  if (openAsk !== null) {
    if (now - openAsk >= CHECKPOINT_PLAN_WAIT_MS) return { kind: "fallback", since: new Date(openAsk) };
    return { kind: "waiting", since: new Date(openAsk) };
  }

  if (!input.lastSentAt) return { kind: "ask", reason: "nothing_sent" };
  const sent = input.lastSentAt.getTime();
  if (input.signalAt && input.signalAt.getTime() >= sent) return { kind: "ask", reason: "signal" };
  const until = sent + watchWindowFor(input.lastChannel, input.leadType ?? null);
  if (now < until) return { kind: "watch", until: new Date(until) };
  return { kind: "ask", reason: "window_closed" };
}

/** The slug a theme is counted under. "Evening status calls" and "evening-status calls" are one theme. */
export function themeSlug(theme: string): string {
  return String(theme ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/**
 * The form's team size read into a band.
 *
 * Forms write it every way a person can: "11–50", "11-50", "50", "200+", "about 30". The
 * band is what results are compared across, so it has to come out the same for all of them.
 */
export function teamBand(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "unknown";
  const numbers = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (numbers.length === 0) return "unknown";
  const top = Math.max(...numbers);
  if (/\+/.test(text) && top >= 200) return "200+";
  if (top <= 10) return "1-10";
  if (top <= 50) return "11-50";
  if (top <= 200) return "51-200";
  return "200+";
}

/** The group a person's results are compared within: segment and team size band. */
export function groupFor(person: Document | null | undefined): string {
  const segment = (person?.belief as { segment?: string } | undefined)?.segment ?? "unclassified";
  const form = ((person?.enrichment as { form?: Record<string, unknown> } | undefined)?.form ?? {}) as Record<string, unknown>;
  return `${segment}|${teamBand(form.team_size ?? form.teamSize ?? person?.teamSize)}`;
}

/** Words a person reads in a written part, links left out. */
export function wordsIn(text: string): number {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * The lead's company as it might appear in copy: the domain's first label, when it is long
 * enough to be a name rather than an accident ("abc" matches too much ordinary text).
 */
export function companyTokens(person: Document | null | undefined): string[] {
  const domain = String(person?.companyDomain ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";
  const label = domain.split(".")[0] ?? "";
  const tokens = new Set<string>();
  if (label.length >= 5) tokens.add(label);
  const company = String((person?.enrichment as { company?: { name?: string } } | undefined)?.company?.name ?? person?.company ?? "").trim();
  if (company.length >= 5) tokens.add(company.toLowerCase());
  return [...tokens];
}

/** A number in copy with nothing near it saying it is an example. Returned as warnings, not refused. */
export function unlabelledNumbers(text: string): string[] {
  const body = String(text ?? "");
  const hits = [...body.matchAll(/(₹\s?[\d,.]+\s*(lakh|crore|k)?|\b\d+(\.\d+)?\s?(%|percent|lakh|crore|hours?|hrs?)\b)/gi)].map((m) => m[0]);
  if (hits.length === 0) return [];
  if (/\b(for example|example|illustrat|typical|suppose|imagine|consider|say a|if a team)\b/i.test(body)) return [];
  return [...new Set(hits)];
}

/**
 * Plain-text rules, from what respected senders do and how mail apps show text/plain
 * (docs/learnings.md, 2026-09-17). Plain text has no bold, no columns and no hidden preview
 * line, so what a reader's eye catches is digits, short lines, a first sentence that doubles
 * as the inbox preview, and symbols that stay text.
 */

/** A cost line's situation stays under this, so Outlook never pulls the arrow line up into it. */
export const COST_LABEL_MAX_CHARS = 39;
/** A cost line's result, and each line of what they would see: one phone line, roughly. */
export const SCAN_LINE_MAX_CHARS = 50;
/** The opening is what an inbox shows after the subject in a plain-text mail. */
export const OPENING_MAX_CHARS = 90;

const NUMBER_WORD = "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred";
const COUNTED_THING =
  "minutes?|hours?|days?|weeks?|months?|years?|quarters?|people|persons?|employees?|staff|members?|consultants?|engineers?|managers?|agents?|planners?|leads?|clients?|customers?|buyers?|orders?|deals?|desks?|seats?|calls?|requests?|approvals?|sign-?offs?|offices?|teams?|companies|sites?|shifts?|times|lakh|crore|thousand|tools?|systems?|registers?|sheets?|emails?|messages?|projects?|weddings?|events?|hires?|names?|steps?";

/**
 * Quantities spelled out where digits would catch the eye: "five days", "nine hours",
 * "three of nine hours". "One" is left alone — "1 engineer" reads worse than it scans.
 */
export function spelledQuantities(text: string): string[] {
  const re = new RegExp(`\\b(${NUMBER_WORD})(-|\\s+)(of\\s+(${NUMBER_WORD})\\s+)?(${COUNTED_THING})\\b`, "gi");
  return [...new Set([...String(text ?? "").matchAll(re)].map((m) => m[0]))];
}

/**
 * Symbols that turn into colour emoji on phones, and "Unicode bold" letters. The safe set
 * (→ – × ÷ = ₹ • ✓ ─) never does. Source: Unicode's emoji data, version 18.0.
 */
export function emojiProneSymbols(text: string): string[] {
  const hits = String(text ?? "").match(/[✔☑✖➡↔-↙▶◀▪▫⚠™©®⭐❗❌✅️]|[\u{1D400}-\u{1D7FF}]/gu);
  return [...new Set(hits ?? [])];
}

/**
 * Two layouts on test (docs/learnings.md PT8): options to reply with a number, and a
 * weekday timeline for an idea told as a story. Each lead sits in one arm of each test for
 * good, decided by its id, so the comparison is between groups of leads rather than
 * between whatever a writer felt like on the day.
 */
export const LAYOUT_TESTS = ["reply_options", "timeline"] as const;
export type LayoutTest = (typeof LAYOUT_TESTS)[number];
export type LayoutArm = "use" | "hold_out";

export function layoutArm(personId: string, test: LayoutTest): LayoutArm {
  let h = 2166136261;
  for (const ch of `${test}:${personId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  // FNV's low bit only tracks the parity of the input, which would put every lead in the
  // same arm of both tests; the finaliser spreads every input bit across the output first.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 2 === 0 ? "use" : "hold_out";
}

/**
 * Plain language (Dhaval, 2026-09-17): the ideas were right but the words were hard for a
 * busy owner to follow. One idea per sentence, and no sentence longer than this.
 */
export const SENTENCE_MAX_WORDS = 20;

/** Sentences over the limit, emphasis marks ignored. */
export function longSentences(text: string, max = SENTENCE_MAX_WORDS): string[] {
  return String(text ?? "")
    .replace(/\*\*/g, "")
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.split(/\s+/).filter(Boolean).length > max);
}

/** The first word from a product's avoid list that the text uses, with the plain word to use instead. */
export function avoidedWord(text: string, list: Array<{ word: string; use: string }>): { word: string; use: string } | null {
  const body = String(text ?? "").replace(/\*\*/g, "");
  for (const entry of list) {
    const word = String(entry?.word ?? "").trim();
    if (!word) continue;
    const re = new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es|d|ed)?(?=$|[^\\p{L}])`, "iu");
    if (re.test(body)) return { word, use: String(entry.use ?? "") };
  }
  return null;
}

/**
 * Lead types (Dhaval, 2026-09-17). A campaign says what kind of people it holds, because
 * that decides how hard each message pushes. Leads who filled in our own ad form asked for
 * the product; writing to them like strangers, with a question and a two-day wait, costs
 * the signup they came for. People on a bought list are the opposite case.
 */
export const LEAD_TYPES = ["hot", "warm", "cold", "reengage", "trial"] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export interface LeadTypeProfile {
  label: string;
  who: string;
  /** The temperature a lead in this campaign is paced at until their own signals say more. */
  band: "hot" | "warm" | "cold";
  /** How long a sent email is watched before the next plan is asked for. */
  watchHours: number;
  /** What every touch asks for by default. */
  ask: "link" | "reply";
  /** Hooks on which a reply ask is still allowed where the default ask is the link. */
  replyHooks: string[];
  /** Most words in the body. Hot emails carry a day-1 receipt and need the room. */
  maxWords: number;
  /** The jobs written touches do in order, where the type has a sequence. */
  sequence?: Array<{ hook: string; job: string }>;
  /** Whether each touch must show the day-1 receipt and the privacy twist before its ask. */
  reveal?: boolean;
  rules: string[];
}

/**
 * How Claude is told to use the idea bank. Dhaval, 2026-09-18: the ideas are there for Claude
 * to learn from, not examples to copy; "this can also be this or that". Each idea carries its
 * pattern (why it lands) and other shapes of the same moment, and the planner writes the shape
 * that fits the lead in front of it. The capability behind it never changes.
 */
export const IDEAS_ARE_TEACHING =
  "The idea bank teaches you what lands with Indian founders; it is not a menu, and not copy to retell. " +
  "Each idea shows a pattern (why it works), the proof (what TeamGrid really does about it) and also: other shapes the same pattern can take. " +
  "Learn the pattern, then write the moment that fits this lead: the idea as told, one of its other shapes, or a new shape you find in their business and their week. " +
  "The 8pm status calls (#7) could just as well be the Saturday WhatsApp round-up, the 7pm sheet every team fills, or something only their office does. " +
  "The shape can change; the proof cannot: say only what the idea's proof says TeamGrid does. idea_refs names the ideas you learned from.";

/**
 * The "no way, it can do that?" email, shared by every type that writes to people who once
 * asked about the product. Hot leads get it at hot pace with two emails planned; warm leads
 * (Dhaval, 2026-09-18: the July–August form leads showed interest once, so they are followed
 * up, not pushed) get the same shape one email at a time.
 */
const NO_WAY_SEQUENCE: Array<{ hook: string; job: string }> = [
  { hook: "daily_question", job: "The question they ask every day (\"any update?\", \"what happened today?\") and the answer TeamGrid already writes by 6pm." },
  { hook: "hidden_bill", job: "The money nobody counted: paid hours with no owner, in rupees for a team their size, and TeamGrid showing those hours from day 1." },
  { hook: "office_habit", job: "An office habit everyone lives with (the quick call that takes an hour, the Monday Excel report, the punch machine, the green dot on WhatsApp) and the feature that makes it unnecessary." },
  { hook: "just_ask", job: "The thing that sounds impossible: ask \"why was this week slow?\" in plain English (Advanced), the team's best hour, or the Monday report that writes itself (Advanced)." },
  { hook: "found_out_late", job: "What they find out too late (the deadline that slipped on Monday, heard on Friday; the few people carrying everything) and seeing it the same day." },
  { hook: "no_watching", job: "The fear of the team's reaction: no screenshots, no keystrokes, breaks pause on their own, everyone sees their own day." },
  { hook: "closing", job: "The last note: should we close the request, or reply call for a walk-through." },
];

/**
 * How a writer picks plain text, the letter or the designed layout, for this person and this
 * mail (Dhaval, 2026-09-21: the design only where it is needed, the letter first where it
 * does the job, decided per lead and per content rather than fixed per campaign).
 */
export const FORMAT_CHOICE =
  "Choose the format for this person and this mail, in this order. " +
  "1 \"text\" for a reply-only ask (the closing note): a plain note reads as a person and gets answered. " +
  "2 Their own record (lead_card engagement_by_format): a format they clicked is used again; after two or more sends, one they open beats one they ignore. " +
  "3 \"letter\" when the story carries the mail with nothing to show (no sample, no cost lines), and always for trust and privacy (no_watching, proof): a typed note is believed where a brochure is not. " +
  "4 \"html\", the designed layout with a picture for the topic, when the mail shows something: a receipt sample, two or more cost lines, a timeline, or a list of what they would see. " +
  "When unsure, \"letter\". format_why names the rule and the evidence, for example \"sample 6pm summary to show; opened the designed welcome twice\".";

const NO_WAY_RULES: string[] = [
  "Five small blocks, a blank line between each: 1 their moment, a line from their own day (opening, then scene); 2 the hidden truth, what it costs or hides (scene, or one cost line for money); 3 the no-way part in reveal: what TeamGrid already knows or does, said plainly and true; 4 the safety line in limit: no screenshots, nothing people type is recorded; 5 question: one short closing line. Then the button.",
  "60 to 110 words. Short lines, one thing per line. If it needs more words, add a line; never make a line longer. The reader must understand it in one quick read.",
  `Start from the idea bank, then the hook. ${IDEAS_ARE_TEACHING} best_fit is ranked for this lead; used_a_lot_this_week are ideas other leads already got. Two leads should rarely get the same shape of an idea. The email stays simple enough for any founder.`,
  "Show, do not describe. When the reveal is about the 6pm summary, time per app or the hours of a day, add receipt: a small sample card right after it, titled as a sample (\"A sample 6pm summary:\", \"A sample day's apps:\", \"A sample day:\"), 2 to 4 lines using only the figures in writing.facts.samples. The nouns may fit their business (\"dealer order lines\"); the figures stay as the sample shows them. The idea's card tag says which card fits.",
  "Humor is an add-on, not a style. Use one light line only where it fits this lead and this idea naturally (the quick call that took 47 minutes, MIS_final_FINAL_v3.xlsx, the punch machine). Most emails have none. Joke about habits, never about people.",
  "Indian office words work: \"any update?\", WFH, WhatsApp, late mark, half day, appraisal, resignation, CTC, ₹ and lakh. Simple English, respectful to the team.",
  "Never colours or screen words (teal, blue, grey, dashboard, widget). Never spy or verdict words (monitor, catch, spy, lazy, unproductive employee). Never a customer quote or a result nobody measured.",
  "Numbers: an example about their team says so; a survey figure names its source (writing.facts.external). Features only from writing.facts; say \"on the Advanced plan\" where it applies.",
  "The reveal names what TeamGrid hands them about this moment: the line tonight's summary would carry, the hours that client took this week, the flag that fires the day a pattern changes. A feature description alone (\"records hours by person and by project, no timesheet\") is not a reveal; it makes them nod, not stop. Two leads should not get the same reveal sentence.",
  `ask "link". ${FORMAT_CHOICE} cta_text names what they will see ("See tomorrow's 6pm summary", "See where the hours go"), from the allowed list.`,
  "Subject: their own words or a surprising truth, 20 to 60 characters (\"The 8pm 'any update?' calls can stop tomorrow\", \"Nobody forgets to work. Everybody forgets to punch.\").",
  "ps is optional: \"P.S. Prefer a 15-minute walk-through first? Reply call.\"",
];

export const LEAD_TYPE_PROFILES: Record<LeadType, LeadTypeProfile> = {
  hot: {
    label: "Hot",
    who: "filled in our own ad or website form, asked for a demo, or visited pricing",
    band: "hot",
    watchHours: 24,
    ask: "link",
    replyHooks: ["closing"],
    maxWords: 110,
    reveal: true,
    // Dhaval, 2026-09-17: short, simple, and "no way, it can do that?". Each email picks the
    // hook that fits this lead best, not a fixed order; the planner takes two not yet sent.
    sequence: NO_WAY_SEQUENCE,
    rules: [
      "These people asked about the product. Each email makes them think: no way, it can do that? It explains one thing simply, never a list of features.",
      ...NO_WAY_RULES,
      "The closing email (hook \"closing\") may ask for a reply instead.",
    ],
  },
  warm: {
    label: "Warm",
    who: "showed interest once and did not sign up: filled in our form weeks ago and went quiet, clicked an ad, downloaded a guide, or said they are just exploring",
    band: "warm",
    watchHours: 48,
    ask: "link",
    replyHooks: ["question", "closing"],
    maxWords: 110,
    reveal: true,
    sequence: NO_WAY_SEQUENCE,
    rules: [
      "These people showed interest once and did not sign up. This is a follow-up, not a first pitch: calm and friendly, one thing per email, and each email makes them think: no way, it can do that? Never mention a form, an ad, a signup or any earlier email, and never open with \"following up\" or \"just checking in\".",
      ...NO_WAY_RULES,
      "Plan one email at a time; the next is planned after seeing what they did with this one. After two links with no click, hook \"question\" asks one short question they can answer in a line (format \"text\", ask \"reply\", no link). The closing email (hook \"closing\") may ask for a reply instead.",
    ],
  },
  cold: {
    label: "Cold",
    who: "an uploaded or bought list who never contacted us",
    band: "cold",
    watchHours: 72,
    ask: "reply",
    replyHooks: [],
    maxWords: 125,
    rules: [
      "Teach first. Plain text, a question they can answer in a line, and no link until they reply or click.",
    ],
  },
  reengage: {
    label: "Re-engage",
    who: "went quiet after a real conversation, a demo or a call, or trials that expired without paying",
    band: "warm",
    watchHours: 72,
    ask: "reply",
    replyHooks: [],
    maxWords: 125,
    rules: [
      "Say what is new or what may have changed for them, and ask one easy question before offering the trial again.",
    ],
  },
  trial: {
    label: "Trial user",
    who: "signed up and has not paid",
    band: "hot",
    watchHours: 24,
    ask: "link",
    replyHooks: ["question"],
    maxWords: 125,
    rules: [
      "Help them reach the first useful report, then lead to the plan that fits. Never ask them to sign up again.",
    ],
  },
};

export function leadTypeOf(goal: Document | null | undefined): LeadType | null {
  const value = String((goal as { leadType?: unknown } | null | undefined)?.leadType ?? "");
  return (LEAD_TYPES as readonly string[]).includes(value) ? (value as LeadType) : null;
}

/**
 * The band a campaign's lead type paces its leads at, before anything they did.
 *
 * A lead in a hot campaign who told us on the form they are only exploring is paced warm
 * until they click.
 */
export function campaignBand(person: Document | null | undefined, goal: Document | null | undefined): string | undefined {
  const type = leadTypeOf(goal);
  if (!type) return undefined;
  const band = LEAD_TYPE_PROFILES[type].band;
  const timeline = (person?.enrichment as { form?: { timeline?: unknown } } | undefined)?.form?.timeline;
  return band === "hot" && /explor|research|just looking|not sure/i.test(String(timeline ?? "")) ? "warm" : band;
}

/**
 * The one temperature a message is paced at: its own campaign's lead type, with two things
 * the person did on top. Silence past the campaign's limit stops them (dead); a recent click
 * brings the next message sooner (hot).
 *
 * Until 2026-09-21 the person also carried a score of their own (fit, opens, a form) that
 * was a second lead type, and the warmer of the two won. A lead then showed "warm" on the
 * screen while being paced hot, so the score was dropped and the campaign's type is the
 * only one.
 */
export function paceBand(person: Document | null | undefined, goal: Document | null | undefined): string | undefined {
  const by = (person?.temp as { by?: string } | undefined)?.by;
  if (by === "silence") return "dead";
  if (by === "click") return "hot";
  return campaignBand(person, goal);
}

/** Whether they clicked something recently enough that it still counts. */
export function clickedRecently(person: Document | null | undefined): boolean {
  return (person?.temp as { by?: string } | undefined)?.by === "click";
}

/** The watch window for a touch, shortened for a lead type that decides fast. */
export function watchWindowFor(channel: string | undefined, leadType: LeadType | null): number {
  const base = watchWindowMs(channel);
  if (!leadType) return base;
  return Math.min(base, LEAD_TYPE_PROFILES[leadType].watchHours * 3_600_000);
}

/** Words a hot email's button may carry: the reveal, or the plain signup. */
export const CTA_TEXTS = [
  "Start your free trial",
  "See the first day",
  "See your team's hours",
  "See a day without watching anyone",
  "See your own hours",
  "See tomorrow's 6pm summary",
  "See where the hours go",
  "See what your office did today",
  "See a real workday",
  "Find your team's best hour",
  "Ask your first question",
  "See the Monday report",
  "See who is carrying the work",
  "See how it works",
  // For a button that goes to one of the product's pages (link_page) rather than the start link.
  "See the comparison",
  "See the plans",
  "See how your data stays safe",
] as const;

/** Colour and screen words: a hot email says what TeamGrid shows, never what its screen looks like. */
export function screenWords(text: string): string[] {
  const hits = String(text ?? "").match(/\b(teal|in blue|in grey|in gray|dashboard|widgets?)\b/gi);
  return [...new Set((hits ?? []).map((h) => h.toLowerCase()))];
}

/**
 * Figures on a sample card that the product's published samples do not carry. A card
 * titled "A sample 6pm summary" is only honest when its hours, times and percentages are
 * the ones on the product's own site; the nouns around them may fit the reader's business.
 */
export function unsampledFigures(lines: string[], samples: string[]): string[] {
  const spelled: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
  const figures = (text: string) =>
    (String(text ?? "").replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, (w) => spelled[w.toLowerCase()] ?? w).match(/\d+(?:[.,:]\d+)*\s?(?:h|m|%)?(?![a-z])/gi) ?? [])
      .map((f) => f.replace(/\s+/g, "").toLowerCase());
  const known = new Set(samples.flatMap(figures));
  return [...new Set(lines.flatMap(figures).filter((f) => !known.has(f)))];
}

/** A day-1 receipt: 2 to 5 short lines under a title that says they are a sample. */
export const RECEIPT_MAX_LINES = 5;
export const RECEIPT_LINE_MAX_CHARS = 48;

/**
 * Lines that read as proof nobody has: a customer or founder being quoted, a result
 * attributed to people who use the product, or catching staff at something.
 */
export function unprovenClaims(text: string): string[] {
  const body = String(text ?? "");
  const hits = [
    ...body.matchAll(/\b(founders?|customers?|clients?|users?|managers?|owners?|teams?|companies|people)\s+(who|that)\s+(use|install|tried|try|switch|start)\w*[^.]{0,60}?\b(say|said|tell|told|report|found|saw)\b/gi),
    ...body.matchAll(/\b(customers?|clients?|users?)\s+(say|tell us|love|report)\b/gi),
    ...body.matchAll(/\b(caught|wasting|slacking|lazy|time pass|shirking|spying|spy on|unproductive employees?)\b/gi),
  ].map((m) => m[0]);
  return [...new Set(hits)];
}
