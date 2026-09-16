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
  const until = sent + watchWindowMs(input.lastChannel);
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
