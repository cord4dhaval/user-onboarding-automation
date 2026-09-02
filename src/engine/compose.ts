import type { OutboundMessage } from "../adapters/channel/types.js";

export interface ComposedContent {
  subject?: string;
  bodyMd: string;
  /**
   * Rendered once, alongside the markdown, and then frozen with it. Deriving it later
   * would let an approved message change between the review screen and the recipient.
   */
  bodyHtml?: string;
  /** The line the inbox shows beside the subject. Never appears in the body. */
  preheader?: string;
  ctaText?: string;
  ctaUrl?: string;
  personalizationUsed: string[];
  claimsMade: string[];
  wordCount: number;
  /**
   * True when bodyMd is this template's own blocks rendered to text, rather than copy a
   * session wrote. Rendering the same message a second time — a held message re-rendered
   * once the channel could carry HTML — otherwise fed that whole body back into the
   * template's open slot, and the recipient got the heading and greeting twice.
   */
  fromBlocks?: boolean;
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

/** What Claude wrote for this touch. Named sections win; `bodyMd` fills anything unnamed. */
export interface Precomposed extends Partial<ComposedContent> {
  slots?: Record<string, string>;
}

export function merge(text: string, vars: MergeVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

/**
 * A block after merge fields and composed copy have been applied, but before any decision
 * about presentation.
 *
 * Both renderers read this list, so the plain-text part and the HTML part of a message can
 * never drift apart — which matters because validation runs against the text.
 */
export type ResolvedBlock =
  | { kind: "preheader"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "text"; text: string }
  | { kind: "list"; style: "bullet" | "strike" | "check"; items: string[] }
  | { kind: "card"; title?: string; rows: Array<{ label: string; value: string }>; accent: boolean }
  | { kind: "callout"; text: string }
  | { kind: "divider" }
  | { kind: "image"; url: string; alt: string; width?: number; href?: string }
  | { kind: "cta"; text: string; url: string }
  | { kind: "optout"; url: string };

export interface ResolvedTemplate {
  subject?: string;
  blocks: ResolvedBlock[];
}

/**
 * Applies merge fields and composed copy to a template's blocks.
 *
 * `precomposed` is what Claude produced during a sweep. When it is absent — as it always
 * is for a first touch, which fires within seconds of the lead landing — slots fall back
 * to their deterministic text. Speed on touch one is worth more than the extra
 * personalisation a model round-trip would add.
 */
export function resolveBlocks(
  blocks: Block[],
  vars: MergeVars,
  precomposed?: Precomposed,
): ResolvedTemplate {
  let subject = precomposed?.subject;
  const out: ResolvedBlock[] = [];
  // An unnamed slot takes the composed body wholesale, and only the first one does —
  // repeating it in a second slot would print the same paragraph twice.
  let bodyUsed = false;

  for (const block of blocks) {
    const type = String(block.type);
    const text = (value: unknown) => (typeof value === "string" ? merge(value, vars) : undefined);

    if (type === "subject") {
      subject ??= text(block.fallback);
      continue;
    }

    if (type === "preheader") {
      const filled = precomposed?.preheader ?? text(block.fallback);
      if (filled) out.push({ kind: "preheader", text: merge(filled, vars) });
      continue;
    }

    if (type === "text") {
      const filled = text(block.fixed);
      if (filled) out.push({ kind: "text", text: filled });
      continue;
    }

    if (type === "slot") {
      const name = typeof block.name === "string" ? block.name : undefined;
      const named = name ? precomposed?.slots?.[name] : undefined;
      let filled = named;
      if (!filled && !name && !bodyUsed && precomposed?.bodyMd && !precomposed.fromBlocks) {
        filled = precomposed.bodyMd;
        bodyUsed = true;
      }
      filled ??= text(block.fallback);
      if (filled) out.push({ kind: "text", text: merge(filled, vars) });
      continue;
    }

    if (type === "heading") {
      const name = typeof block.slot === "string" ? block.slot : undefined;
      const filled =
        text(block.fixed) ??
        (name ? precomposed?.slots?.[name] : undefined) ??
        text(block.fallback);
      if (filled) {
        out.push({ kind: "heading", level: Number(block.level ?? 1), text: merge(filled, vars) });
      }
      continue;
    }

    if (type === "list" && Array.isArray(block.items)) {
      const items = (block.items as unknown[]).map((item) => merge(String(item), vars)).filter(Boolean);
      if (items.length) {
        const style = String(block.style ?? "bullet") as "bullet" | "strike" | "check";
        out.push({ kind: "list", style, items });
      }
      continue;
    }

    if (type === "card" && Array.isArray(block.rows)) {
      const rows = (block.rows as Array<Record<string, unknown>>).map((row) => ({
        label: merge(String(row.label ?? ""), vars),
        value: merge(String(row.value ?? ""), vars),
      }));
      if (rows.length) {
        out.push({
          kind: "card",
          title: text(block.title),
          rows,
          accent: Boolean(block.accent),
        });
      }
      continue;
    }

    if (type === "callout") {
      const filled = text(block.fixed);
      if (filled) out.push({ kind: "callout", text: filled });
      continue;
    }

    if (type === "divider") {
      out.push({ kind: "divider" });
      continue;
    }

    if (type === "image" && typeof block.url === "string") {
      out.push({
        kind: "image",
        url: merge(block.url, vars),
        alt: typeof block.alt === "string" ? merge(block.alt, vars) : "",
        width: typeof block.width === "number" ? block.width : undefined,
        href: typeof block.href === "string" ? merge(block.href, vars) : undefined,
      });
      continue;
    }

    if (type === "cta" && typeof block.fixed === "string" && typeof block.url === "string") {
      out.push({ kind: "cta", text: merge(block.fixed, vars), url: merge(block.url, vars) });
      continue;
    }

    if (type === "system" && block.fixed === "opt_out_block") {
      out.push({ kind: "optout", url: vars.opt_out_url });
      continue;
    }
  }

  return { subject, blocks: out };
}

/** The plain-text part, and the form every guardrail is checked against. */
export function renderTemplate(
  blocks: Block[],
  vars: MergeVars,
  precomposed?: Precomposed,
): ComposedContent {
  const resolved = resolveBlocks(blocks, vars, precomposed);
  const parts: string[] = [];
  let ctaText: string | undefined;
  let ctaUrl: string | undefined;
  let preheader: string | undefined;

  for (const block of resolved.blocks) {
    switch (block.kind) {
      case "preheader":
        preheader ??= block.text;
        break;
      case "heading":
      case "text":
      case "callout":
        parts.push(block.text);
        break;
      case "list":
        parts.push(block.items.map((item) => `• ${item}`).join("\n"));
        break;
      case "card":
        parts.push(
          [block.title, ...block.rows.map((row) => `${row.label}: ${row.value}`)]
            .filter(Boolean)
            .join("\n"),
        );
        break;
      case "divider":
        break;
      case "image":
        // An image with no words is nothing in a text part; its alt text is the content.
        if (block.alt) parts.push(block.alt);
        break;
      case "cta":
        ctaText = block.text;
        ctaUrl = block.url;
        parts.push(`${block.text}: ${block.url}`);
        break;
      case "optout":
        parts.push(`\n—\nNot useful? Unsubscribe: ${block.url}`);
        break;
    }
  }

  const personalizationUsed: string[] = [];
  for (const key of ["first_name", "company"] as const) {
    if (vars[key] && vars[key] !== "there") personalizationUsed.push(key);
  }

  const bodyMd = parts.join("\n\n").trim();
  return {
    subject: resolved.subject,
    bodyMd,
    preheader,
    ctaText,
    ctaUrl,
    personalizationUsed,
    claimsMade: precomposed?.claimsMade ?? [],
    wordCount: bodyMd.split(/\s+/).filter(Boolean).length,
    // Copy a session wrote keeps its provenance; blocks read back to text declare theirs,
    // so a later render can tell the two apart.
    fromBlocks: precomposed?.bodyMd ? precomposed.fromBlocks : true,
  };
}

export function toOutbound(
  content: ComposedContent,
  to: string,
  from?: string,
  html?: string,
): OutboundMessage {
  return {
    to,
    from,
    subject: content.subject,
    bodyText: content.bodyMd,
    bodyHtml: html ?? content.bodyHtml,
  };
}
