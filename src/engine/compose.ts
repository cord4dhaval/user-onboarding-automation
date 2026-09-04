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
  /**
   * The copy a session wrote for this touch's open slot, kept apart from `bodyMd` for the
   * whole life of the action.
   *
   * `bodyMd` is the finished message — greeting, slot, list, call to action, opt-out — and
   * a second render has to be able to tell the part Claude wrote from the part the
   * template contributed. Holding both in one field cannot: the first render turns the
   * slot copy into the whole body, and the next one feeds that body back into the slot.
   * Carrying the slot separately means a message can be rendered any number of times and
   * still say what its author wrote, once.
   */
  slotText?: string;
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

/**
 * What Claude wrote for this touch. Named sections win; `slotText` fills the first unnamed
 * slot, and `bodyMd` does the same for copy that arrived before slots existed.
 */
export interface Precomposed extends Partial<ComposedContent> {
  slots?: Record<string, string>;
}

/** "Hi Kiran," — a salutation line, not a sentence that happens to start with a name. */
function looksLikeGreeting(line: string): boolean {
  return /^\s*(hi|hey|hello|dear)\b[^.!?]{0,40}[,:—-]?\s*$/i.test(line.split("\n")[0] ?? "");
}

/**
 * Drops a salutation the composed copy opens with, where the template supplies its own.
 *
 * Only the first line, and only when it is unmistakably a greeting: a paragraph that merely
 * begins with the reader's name is the writing doing its job and must survive.
 */
function withoutGreeting(body: string): string {
  const lines = body.split("\n");
  const first = lines[0] ?? "";
  if (!looksLikeGreeting(first) && !/^\s*[A-Z][a-z]+,\s*$/.test(first)) return body;
  return lines.slice(1).join("\n").replace(/^\s+/, "");
}

/**
 * Removes a name from the subject when there was no name.
 *
 * "Hi there," is a perfectly ordinary way to open a message. "there, your workspace is
 * ready" in an inbox is not — it reads as a mail merge that failed, which is exactly the
 * impression a first message cannot afford. The body keeps its greeting; only the subject,
 * where the name carries no warmth and all the risk, drops the clause.
 */
function tidySubject(subject: string | undefined, vars: MergeVars): string | undefined {
  const fallback = vars.first_name;
  if (!subject || !fallback || fallback !== "there") return subject;

  const stripped = subject.replace(new RegExp(`^${fallback}\\s*[,:—-]\\s*`, "i"), "");
  if (stripped === subject) return subject;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
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
  /** Whether the template has already greeted the reader by the time a slot is filled. */
  let greeted = false;

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
      if (filled) {
        if (looksLikeGreeting(filled)) greeted = true;
        out.push({ kind: "text", text: filled });
      }
      continue;
    }

    if (type === "slot") {
      const name = typeof block.name === "string" ? block.name : undefined;
      const named = name ? precomposed?.slots?.[name] : undefined;
      let filled = named;
      if (!filled && !name && !bodyUsed) {
        // `slotText` is the composed copy on its own and survives any number of renders.
        // `bodyMd` is the older shape — copy that arrived before the slot was a separate
        // field — and is only safe to reuse while it has not yet been through a render,
        // which is exactly what `fromBlocks` records.
        const composed =
          precomposed?.slotText ??
          (precomposed?.bodyMd && !precomposed.fromBlocks ? precomposed.bodyMd : undefined);
        if (composed) {
          // The template already said hello. A session writing for one person naturally
          // opens with a greeting too, and the two together produce "Hi Kiran," twice in a
          // row at the top of a real email — which no amount of prompting reliably
          // prevents, because writing to a named human is exactly what the copy is for.
          filled = greeted ? withoutGreeting(composed) : composed;
          bodyUsed = true;
        }
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

  return { subject: tidySubject(subject, vars), blocks: out };
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
    fromBlocks: precomposed?.slotText || precomposed?.bodyMd ? precomposed.fromBlocks : true,
    // Carried forward rather than consumed. The rendered body is stored back on the action,
    // and without this the next render would find nothing but its own previous output.
    slotText: precomposed?.slotText,
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
