import type { ComposedContent } from "./compose.js";

export interface ValidationResult {
  ok: boolean;
  hardFails: string[];
  softFails: string[];
}

export interface ValidationContext {
  channelKey: string;
  maxWords?: number;
  noClaims?: string[];
  /** Every claim made earlier in this goal instance. A touch must not repeat one. */
  priorClaims?: string[];
  /** Hard limits the provider itself enforces; exceeding them is a rejected send. */
  maxSubjectLength?: number;
  maxBodyLength?: number;
  /**
   * A one-to-one answer to something this person wrote, rather than a campaign touch.
   *
   * The opt-out block is not required on one. They opened the conversation; an unsubscribe
   * footer under a direct answer to their question reads as a form letter, and saying
   * "stop" in a sentence already works — the inbound poller honours it within the minute,
   * before any routine sees it. Every other check still applies.
   */
  isReply?: boolean;
  /** What this message asks for. A reply ask that still carries a link is not one. */
  ask?: "reply" | "link";
}

/**
 * Long enough to say something, short enough that a phone shows all of it: 68% of first
 * opens happen on a phone, and a subject over 45 characters is cut off there.
 */
const SUBJECT_MIN = 18;
const SUBJECT_MAX = 45;

/**
 * Words people write but never say. A subject built from them reads as an advertisement,
 * and an advertisement is deleted without being opened. The replacement is on the right
 * of each pair in the product's writing.wordsAvoid; this list is the floor under it.
 */
const BODY_WRITING_WORDS = [
  "payroll",
  "attendance",
  "timesheet",
  "timesheets",
  "overtime",
  "idle",
];

const SUBJECT_WRITING_WORDS = [
  "payroll",
  "attendance",
  "timesheet",
  "timesheets",
  "overtime",
  "idle",
  "pipeline",
  "productivity",
  "capacity",
  "visibility",
  "bottleneck",
  "bottlenecks",
  "loaded",
  "leverage",
  "optimise",
  "optimize",
  "streamline",
  "seamless",
  "solution",
  "unlock",
  "boost",
  "empower",
  "revolutionise",
  "revolutionize",
];

/**
 * Runs in engine code, never in a prompt. A model must not be able to argue its way past
 * a missing opt-out or a repeated claim, so these checks live where they cannot be
 * negotiated with.
 */
/** Words a reader actually reads: links and the opt-out line left out. */
export function readableWords(bodyMd: string): number {
  return bodyMd
    .replace(/https?:\/\/\S+/g, "")
    .replace(/Not useful\?\s*Unsubscribe:?/i, "")
    .replace(/Not useful\? Reply "remove me" and we will not write again\.\s*Unsubscribe:?/i, "")
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word)).length;
}

export function validate(content: ComposedContent, ctx: ValidationContext): ValidationResult {
  const hardFails: string[] = [];
  const softFails: string[] = [];

  const unfilled = content.bodyMd.match(/\{\{\w+\}\}/g);
  if (unfilled) hardFails.push(`unfilled placeholders: ${[...new Set(unfilled)].join(", ")}`);

  if (!content.bodyMd.trim()) hardFails.push("empty body");

  if (ctx.channelKey === "email") {
    if (!content.subject?.trim()) hardFails.push("email has no subject");
    if (!ctx.isReply && !/unsubscribe/i.test(content.bodyMd)) hardFails.push("missing opt-out block");
  }

  if (content.ctaUrl && !/^https?:\/\//.test(content.ctaUrl)) {
    hardFails.push(`CTA url is not absolute: ${content.ctaUrl}`);
  }

  for (const claim of ctx.noClaims ?? []) {
    if (content.bodyMd.toLowerCase().includes(claim.toLowerCase())) {
      hardFails.push(`forbidden claim: "${claim}"`);
    }
  }

  // A claim says what the product does, and saying it twice wastes a mail. What it never does
  // is a promise, and the hot and warm rules require it before every button: refusing it as a
  // repeat failed every second mail to a lead from 2026-09-18 (66 on teamgrid_leads_v3).
  for (const claim of content.claimsMade) {
    if (ctx.priorClaims?.includes(claim) && !isReassurance(claim)) hardFails.push(`claim already made earlier: "${claim}"`);
  }

  const subject = content.subject?.trim() ?? "";
  if (ctx.channelKey === "email" && !ctx.isReply && subject) {
    // Soft, because a good subject occasionally breaks a rule and a send is worth more
    // than a style point. Reported so a person reading Review can see which rule it broke.
    if (subject.length < SUBJECT_MIN || subject.length > SUBJECT_MAX) {
      softFails.push(`subject is ${subject.length} characters; aim for ${SUBJECT_MIN} to ${SUBJECT_MAX}`);
    }
    if (/^welcome\b/i.test(subject)) {
      softFails.push('subject opens with "welcome", which says nothing to somebody who did not sign up');
    }
    // A figure or a question mark in a subject is the shape of an advertisement, and the
    // measured cost is large: digits lose about 46% of opens, a question mark about 56%.
    // The reason to open is that the line is about their own work, not that it is clever.
    if (/\d/.test(subject)) {
      softFails.push("subject carries a number; a figure in a subject reads as an advertisement");
    }
    if (/[?!:]/.test(subject)) {
      softFails.push("subject carries ? ! or :, which reads as a sales line and scores as spam on Outlook");
    }
    const writingWords = SUBJECT_WRITING_WORDS.filter((word) =>
      new RegExp(`\\b${word}\\b`, "i").test(subject),
    );
    if (writingWords.length) {
      softFails.push(
        `subject uses words people write but do not say (${writingWords.join(", ")}); say it the way an owner says it on the phone`,
      );
    }
  }

  // The five words that kept appearing in composed mail in the fortnight to 2026-09-24
  // although the brief already asked for a shop owner's words: 41 of 200 mails carried one.
  // Soft, because the product genuinely does mark who came in and fill the hours sheet, and
  // a mail is worth more than a word swap — but the reviewer sees which word to change.
  if (ctx.channelKey === "email") {
    const bodyWords = BODY_WRITING_WORDS.filter((word) =>
      new RegExp(`\\b${word}\\b`, "i").test(content.bodyMd),
    );
    if (bodyWords.length) {
      softFails.push(
        `body uses office words (${bodyWords.join(", ")}); say salary, who came in, hours sheet, staying late, free`,
      );
    }
  }
  if (ctx.ask === "reply") {
    // Every link but the opt-out, which the footer adds and the reader is entitled to: the
    // full signed /api/u/ link, or the short /u/<id>.<sig> form printed in plain text.
    // Not `\b` after the signature: one ending in "-" has no word boundary before the end,
    // so that reader's own opt-out link failed every message that asked them for a reply.
    const links = (content.bodyMd.match(/https?:\/\/\S+/g) ?? []).filter(
      (url) =>
        !/\/api\/u\//.test(url) && !/\/u\/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])/.test(url),
    );
    if (links.length > 0) hardFails.push(`this message asks for a reply but carries a link: ${links[0]}`);
    if (content.ctaUrl) hardFails.push("this message asks for a reply but still renders a button");
  }
  if (ctx.maxSubjectLength && (content.subject?.length ?? 0) > ctx.maxSubjectLength) {
    hardFails.push(`subject is ${content.subject?.length} characters, over the provider limit of ${ctx.maxSubjectLength}`);
  }
  if (ctx.maxBodyLength && content.bodyMd.length > ctx.maxBodyLength) {
    hardFails.push(`body is ${content.bodyMd.length} characters, over the provider limit of ${ctx.maxBodyLength}`);
  }

  if (ctx.maxWords && content.wordCount > ctx.maxWords) {
    softFails.push(`${content.wordCount} words, over the ${ctx.maxWords} limit`);
  }

  // A campaign mail is read in under a minute or not at all. Counted without links and the
  // opt-out line, which nobody reads as part of the message. A reply is exempt: answering
  // a real question can take longer.
  if (ctx.channelKey === "email" && !ctx.isReply) {
    const readable = readableWords(content.bodyMd);
    if (readable > 200) softFails.push(`${readable} words to read, over the 200 a campaign mail stays under`);
  }

  return { ok: hardFails.length === 0, hardFails, softFails };
}

/** A line about what is not recorded (no screenshots, nothing typed, work away from a computer). */
export function isReassurance(claim: string): boolean {
  return /\bno screenshots?\b|\bnever\b|\bnot recorded\b|\bnothing (?:people|anyone|anybody) types?\b|\bnothing typed\b|\bonly computer work\b|\baway from a computer\b/i.test(claim);
}
