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

/** Long enough to say something, short enough that an inbox shows all of it. */
const SUBJECT_MIN = 20;
const SUBJECT_MAX = 60;

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

  for (const claim of content.claimsMade) {
    if (ctx.priorClaims?.includes(claim)) hardFails.push(`claim already made earlier: "${claim}"`);
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
    if (!/\d/.test(subject) && !/\?$/.test(subject)) {
      softFails.push("subject carries no number and asks nothing; give the reader a reason to open it");
    }
  }
  if (ctx.ask === "reply") {
    // Every link but the opt-out, which the footer adds and the reader is entitled to.
    const links = (content.bodyMd.match(/https?:\/\/\S+/g) ?? []).filter((url) => !/\/api\/u\//.test(url));
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
