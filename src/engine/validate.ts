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
}

/**
 * Runs in engine code, never in a prompt. A model must not be able to argue its way past
 * a missing opt-out or a repeated claim, so these checks live where they cannot be
 * negotiated with.
 */
export function validate(content: ComposedContent, ctx: ValidationContext): ValidationResult {
  const hardFails: string[] = [];
  const softFails: string[] = [];

  const unfilled = content.bodyMd.match(/\{\{\w+\}\}/g);
  if (unfilled) hardFails.push(`unfilled placeholders: ${[...new Set(unfilled)].join(", ")}`);

  if (!content.bodyMd.trim()) hardFails.push("empty body");

  if (ctx.channelKey === "email") {
    if (!content.subject?.trim()) hardFails.push("email has no subject");
    if (!/unsubscribe/i.test(content.bodyMd)) hardFails.push("missing opt-out block");
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

  if (ctx.maxSubjectLength && (content.subject?.length ?? 0) > ctx.maxSubjectLength) {
    hardFails.push(`subject is ${content.subject?.length} characters, over the provider limit of ${ctx.maxSubjectLength}`);
  }
  if (ctx.maxBodyLength && content.bodyMd.length > ctx.maxBodyLength) {
    hardFails.push(`body is ${content.bodyMd.length} characters, over the provider limit of ${ctx.maxBodyLength}`);
  }

  if (ctx.maxWords && content.wordCount > ctx.maxWords) {
    softFails.push(`${content.wordCount} words, over the ${ctx.maxWords} limit`);
  }

  return { ok: hardFails.length === 0, hardFails, softFails };
}
