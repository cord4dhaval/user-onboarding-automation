import type { OutboundMessage } from "../adapters/channel/types.js";

export interface ComposedContent {
  subject?: string;
  bodyMd: string;
  ctaText?: string;
  ctaUrl?: string;
  personalizationUsed: string[];
  claimsMade: string[];
  wordCount: number;
}

type Block = Record<string, unknown>;

export interface MergeVars {
  first_name: string;
  full_name: string;
  company: string;
  /** Product configs build their trial link from this, so it has to be in the vocabulary. */
  person_id: string;
  trial_link: string;
  opt_out_url: string;
  [key: string]: string;
}

function merge(text: string, vars: MergeVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

/**
 * Renders a template's blocks into a message.
 *
 * `precomposed` is what Claude produced during a sweep. When it is absent — as it always
 * is for a first touch, which fires within seconds of the lead landing — slots fall back
 * to their deterministic text. Speed on touch one is worth more than the extra
 * personalisation a model round-trip would add.
 */
export function renderTemplate(
  blocks: Block[],
  vars: MergeVars,
  precomposed?: Partial<ComposedContent>,
): ComposedContent {
  let subject = precomposed?.subject;
  const parts: string[] = [];
  let ctaText: string | undefined;
  let ctaUrl: string | undefined;
  const personalizationUsed: string[] = [];

  for (const block of blocks) {
    const type = String(block.type);

    if (type === "subject") {
      subject ??= typeof block.fallback === "string" ? merge(block.fallback, vars) : undefined;
      continue;
    }
    if (type === "text" && typeof block.fixed === "string") {
      parts.push(merge(block.fixed, vars));
      continue;
    }
    if (type === "slot") {
      const filled =
        precomposed?.bodyMd ?? (typeof block.fallback === "string" ? merge(block.fallback, vars) : undefined);
      if (filled) parts.push(filled);
      continue;
    }
    if (type === "cta" && typeof block.fixed === "string" && typeof block.url === "string") {
      ctaText = merge(block.fixed, vars);
      ctaUrl = merge(block.url, vars);
      parts.push(`${ctaText}: ${ctaUrl}`);
      continue;
    }
    if (type === "system" && block.fixed === "opt_out_block") {
      parts.push(`\n—\nNot useful? Unsubscribe: ${vars.opt_out_url}`);
      continue;
    }
  }

  for (const key of ["first_name", "company"] as const) {
    if (vars[key] && vars[key] !== "there") personalizationUsed.push(key);
  }

  const bodyMd = parts.join("\n\n").trim();
  return {
    subject,
    bodyMd,
    ctaText,
    ctaUrl,
    personalizationUsed,
    claimsMade: precomposed?.claimsMade ?? [],
    wordCount: bodyMd.split(/\s+/).filter(Boolean).length,
  };
}

export function toOutbound(content: ComposedContent, to: string, from?: string): OutboundMessage {
  return { to, from, subject: content.subject, bodyText: content.bodyMd };
}
