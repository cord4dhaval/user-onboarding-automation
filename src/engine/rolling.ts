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
  | { kind: "ask"; reason: "window_closed" | "signal" | "nothing_sent" }
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
  rules: string[];
}

export const LEAD_TYPE_PROFILES: Record<LeadType, LeadTypeProfile> = {
  hot: {
    label: "Hot",
    who: "filled in our own ad or website form, asked for a demo, or visited pricing",
    band: "hot",
    watchHours: 24,
    ask: "link",
    replyHooks: ["closing"],
    rules: [
      "These people asked about the product. Every touch pushes the next step: sign up with the trial link.",
      "The idea for this lead is the reason to act now, not a lesson. Keep it short, then lead straight into the trial.",
      "ask \"link\" and format \"letter\" (or \"html\" where a table or screen carries the idea). Never a plain note that only asks a question.",
      "question is the one line that leads into the trial link, for example \"Setup takes about 5 minutes per computer, and the 7-day trial needs no card.\" It does not have to be a question.",
      "ps offers a walk-through for anyone not ready to start alone: \"Prefer a quick walk-through first? Reply \\\"call\\\" and we will send 15-minute times.\"",
      "Where they clicked a trial link and have not signed up, the next touch is about finishing setup: how short it is and what they see on day one.",
      "The last touch of the campaign may ask for a reply instead (hook \"closing\"): \"Should we close your request, or is it still on your list?\" with reply options where the lead's test arm uses them.",
      "Subject promises what they get or see, in plain words (\"See which dealer orders are stuck, from tomorrow\"), not a question to think about.",
    ],
  },
  warm: {
    label: "Warm",
    who: "showed interest without asking: clicked an ad, downloaded a guide, or said they are just exploring",
    band: "warm",
    watchHours: 48,
    ask: "link",
    replyHooks: ["question", "closing"],
    rules: [
      "One idea from their world, then the trial link or a short reply question when a link has already been ignored.",
    ],
  },
  cold: {
    label: "Cold",
    who: "an uploaded or bought list who never contacted us",
    band: "cold",
    watchHours: 72,
    ask: "reply",
    replyHooks: [],
    rules: [
      "Teach first. Plain text, a question they can answer in a line, and no link until they reply or click.",
    ],
  },
  reengage: {
    label: "Re-engage",
    who: "old leads who went quiet, or trials that expired without paying",
    band: "warm",
    watchHours: 72,
    ask: "reply",
    replyHooks: [],
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
 * The temperature a lead is paced at inside their campaign.
 *
 * A campaign's lead type sets the floor. A person gone dead stays dead, and a lead in a hot
 * campaign who told us they are only exploring is paced as warm until they click.
 */
export function effectiveBand(personBand: string | undefined, leadType: LeadType | null, formTimeline?: unknown): string | undefined {
  if (!leadType || personBand === "dead") return personBand;
  const floor = LEAD_TYPE_PROFILES[leadType].band;
  const rank: Record<string, number> = { cold: 0, warm: 1, hot: 2 };
  let wanted: string = floor;
  if (floor === "hot" && personBand !== "hot" && /explor|research|just looking|not sure/i.test(String(formTimeline ?? ""))) wanted = "warm";
  return (rank[personBand ?? ""] ?? -1) > (rank[wanted] ?? -1) ? personBand : wanted;
}

/** The watch window for a touch, shortened for a lead type that decides fast. */
export function watchWindowFor(channel: string | undefined, leadType: LeadType | null): number {
  const base = watchWindowMs(channel);
  if (!leadType) return base;
  return Math.min(base, LEAD_TYPE_PROFILES[leadType].watchHours * 3_600_000);
}
