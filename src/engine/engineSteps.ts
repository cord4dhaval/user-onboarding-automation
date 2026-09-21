import type { Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Provider variables a writer fills. An approved WhatsApp template goes by name with its
 * variables filled in, and these two are the only ones that are words written for one
 * person rather than facts the engine already holds (their name, their trial link).
 */
export const WRITTEN_PARAMS = ["message", "question"] as const;

/** At most this many words in a template's {{message}}, and in its {{question}}. */
export const WRITTEN_MESSAGE_MAX_WORDS = 60;
export const WRITTEN_QUESTION_MAX_WORDS = 25;

/**
 * Whether a template cannot go out until a writer has filled its provider variables.
 *
 * Such a template has nothing of its own to send: queued empty, it reaches the provider
 * with {{message}} blank and is refused. So a step through one is always a session's to
 * write, however ordinary the lead.
 */
export function takesWrittenWords(template: Document | null | undefined): boolean {
  const params = (template?.providerTemplate as { params?: Record<string, string> } | undefined)?.params ?? {};
  return Object.values(params).some((ref) => (WRITTEN_PARAMS as readonly string[]).includes(ref));
}

/** The provider variables of a template that a writer fills, in the template's order. */
export function writtenParamsOf(template: Document | null | undefined): string[] {
  const params = (template?.providerTemplate as { params?: Record<string, string> } | undefined)?.params ?? {};
  return Object.values(params).filter((ref) => (WRITTEN_PARAMS as readonly string[]).includes(ref));
}

export interface WrittenTemplates {
  /** Active templates that need a writer's words, by key. */
  byKey: Map<string, Document>;
  /**
   * Channels where nothing but a first touch goes out without a writer. A step there that
   * names no template, or one that does not exist, is still a session's to write: the
   * writer picks which of the channel's templates carries it.
   */
  channels: Set<string>;
  /** Every active template key on the product, written or not. */
  activeKeys: Set<string>;
}

export async function writtenTemplatesFor(orgId: string, productId: string): Promise<WrittenTemplates> {
  const db = await getDb();
  const rows = await db
    .collection(C.templates)
    .find({ orgId, productId, status: "active" })
    .project({ key: 1, channel: 1, stage: 1, scope: 1, providerTemplate: 1, blocks: 1 })
    .toArray();
  const byKey = new Map<string, Document>();
  const sendsAlone = new Set<string>();
  const hasWritten = new Set<string>();
  for (const t of rows) {
    const channel = String(t.channel ?? "email");
    if (takesWrittenWords(t)) {
      hasWritten.add(channel);
      const seen = byKey.get(String(t.key));
      if (!seen || t.scope === "product_default") byKey.set(String(t.key), t);
    } else if (String(t.stage) !== "first_touch") {
      sendsAlone.add(channel);
    }
  }
  return {
    byKey,
    channels: new Set([...hasWritten].filter((c) => !sendsAlone.has(c))),
    activeKeys: new Set(rows.map((t) => String(t.key))),
  };
}

/**
 * Whether a plan step can only go out with a session's words in it: it names a template
 * that takes them, or it goes on a channel where every template does and names none of
 * that channel's others (nothing, or a key that does not exist).
 */
export function stepNeedsWords(step: Document | null | undefined, written: WrittenTemplates): boolean {
  if (!step) return false;
  const key = String(step.templateKey ?? step.template_key ?? "");
  if (written.byKey.has(key)) return true;
  return written.channels.has(String(step.channel ?? "email")) && !written.activeKeys.has(key);
}

/**
 * Plan steps the engine renders itself, by template key, with the reason.
 *
 * Two kinds. A template that belongs to a family of variants (the welcome mails): the
 * variant is the message, picked by segment and by what has won, and a session's freehand
 * in its slot would replace a tested first mail. And a template with no slot at all: it
 * goes out as written, so copy composed for it would be thrown away at render — which is
 * what happened to a re-qualify message before this existed.
 *
 * Under a compose-all campaign these are the exceptions: every other step is a session's.
 */
export async function engineRenderedKeysFor(orgId: string, productId: string): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db
    .collection(C.templates)
    .find({ orgId, productId, status: "active" })
    .project({ key: 1, family: 1, blocks: 1 })
    .toArray();
  const out = new Map<string, string>();
  for (const t of rows) {
    const key = String(t.key ?? "");
    const family = typeof t.family === "string" && t.family ? t.family : null;
    // Only the open body slot makes a template a session's to write. A named slot such as
    // the PS line is optional polish with a fallback, and must not pull a mail that goes out
    // as written away from the engine.
    const hasSlot = ((t.blocks ?? []) as Array<{ type?: unknown; name?: unknown }>).some(
      (b) => String(b?.type) === "slot" && !b?.name,
    );
    if (family) {
      out.set(family, "sends the next variant of this family itself");
      // A plan written for one person names a member of the family directly. That member is
      // a session's to write only if it has somewhere for the words to land.
      if (key && !hasSlot && key !== family && !out.has(key)) out.set(key, "the template has no slot for written copy; it goes out as written");
      continue;
    }
    if (key && !hasSlot && !out.has(key)) out.set(key, "the template has no slot for written copy; it goes out as written");
  }
  return out;
}

/** A compact picture of the skeleton a session's words land in, in block order. */
export interface SkeletonPart {
  part: "subject" | "preheader" | "heading" | "fixed" | "your_words" | "question" | "ps" | "asset" | "cta" | "opt_out" | "button";
  text?: string;
  instruction?: string;
  fallback?: string;
  tier?: string;
}

export interface Skeleton {
  template_key: string;
  parts: SkeletonPart[];
  note: string;
  /**
   * For a provider template a writer fills: the other templates on its channel that could
   * carry this step instead, named in compose_batch as template_key.
   */
  choices?: Array<{ template_key: string; takes: string[]; buttons: string[] }>;
}

/**
 * The template a plan step names, as the writer should see it: what is fixed, where their
 * words go, what the button says. A session that cannot see this ends its message with a
 * sign-off the template repeats, or proposes meeting times the fixed text below it
 * contradicts.
 */
export async function skeletonFor(orgId: string, productId: string, key: string, segment: string | null): Promise<Skeleton | null> {
  const db = await getDb();
  const rows = await db.collection(C.templates).find({ orgId, productId, key, status: "active" }).toArray();
  if (rows.length === 0) return null;
  const chosen =
    rows.find((t) => String(t.scope) === "segment" && segment && String(t.segmentKey) === segment) ??
    rows.find((t) => String(t.scope) !== "segment") ??
    rows[0];
  if (!chosen) return null;

  const parts: SkeletonPart[] = [];
  let hasSlot = false;
  let hasPs = false;
  let hasAsset = false;
  for (const raw of (chosen.blocks ?? []) as Array<Record<string, unknown>>) {
    const type = String(raw.type);
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    if (type === "subject") parts.push({ part: "subject", fallback: str(raw.fallback), instruction: str(raw.slot) });
    else if (type === "preheader") parts.push({ part: "preheader", fallback: str(raw.fallback), instruction: str(raw.slot) });
    else if (type === "heading") parts.push({ part: "heading", fallback: str(raw.fallback), instruction: str(raw.slot) });
    else if (type === "text") parts.push({ part: "fixed", text: str(raw.fixed) ?? str(raw.text) });
    else if (type === "slot" && str(raw.name) === "ps") {
      hasPs = true;
      parts.push({ part: "ps", instruction: str(raw.instruct) ?? str(raw.instruction), fallback: str(raw.fallback) });
    } else if (type === "slot" && str(raw.name) === "question") {
      parts.push({ part: "question", instruction: str(raw.instruct) ?? str(raw.instruction) });
    } else if (type === "slot") {
      hasSlot = true;
      parts.push({ part: "your_words", instruction: str(raw.instruct) ?? str(raw.instruction), fallback: str(raw.fallback) });
    } else if (type === "asset") {
      hasAsset = true;
      parts.push({ part: "asset", tier: str(raw.tier), text: str(raw.ref) ? `pinned: ${String(raw.ref)}` : "the asset you carry, if any" });
    } else if (type === "cta") parts.push({ part: "cta", text: str(raw.fixed) ?? str(raw.label) });
    else if (type === "system") parts.push({ part: "opt_out" });
  }

  // An approved provider template: the words around its variables are Meta's, so the only
  // thing written is what goes into {{message}} (and {{question}}, where it has one).
  if (takesWrittenWords(chosen)) {
    const approved = chosen.providerTemplate as { name?: string; footer?: string; buttons?: Array<{ text?: string }> };
    if (approved.footer) parts.push({ part: "fixed", text: approved.footer });
    for (const b of approved.buttons ?? []) if (b.text) parts.push({ part: "button", text: b.text });
    const takes = writtenParamsOf(chosen);
    const siblings = await db
      .collection(C.templates)
      .find({ orgId, productId, channel: chosen.channel, status: "active" })
      .toArray();
    const choices = [...new Map(siblings.filter(takesWrittenWords).map((t) => [String(t.key), t])).values()].map((t) => ({
      template_key: String(t.key),
      takes: writtenParamsOf(t),
      buttons: ((t.providerTemplate as { buttons?: Array<{ text?: string }> }).buttons ?? []).map((b) => String(b.text ?? "")).filter(Boolean),
    }));
    const note = [
      `This goes as the approved ${String(chosen.channel)} template "${String(approved.name ?? key)}": only its variables change, and every fixed part above is sent as it is.`,
      `body fills {{message}}: one paragraph of at most ${WRITTEN_MESSAGE_MAX_WORDS} words, no line break, no link, no greeting and no sign-off.`,
      takes.includes("question")
        ? `question fills {{question}}: one line of at most ${WRITTEN_QUESTION_MAX_WORDS} words ending in a question mark, answerable in a word or with a button.`
        : "It has no {{question}}; leave question out.",
      choices.length > 1 ? "Another template in choices may carry this step instead: pass its key as template_key." : "",
    ].filter(Boolean).join(" ");
    return { template_key: key, parts, note, choices };
  }

  const notes = [
    hasSlot
      ? "Write only the your_words part: at most 90 words, no link. The template supplies the greeting, the button and the sign-off, and the finished mail stays under 200 words. You may also pass a preheader: under 90 characters, one detail from their situation, never a repeat of the subject."
      : "This template has no slot: nothing you write can land in it.",
  ];
  if (hasPs) {
    notes.push('This template has a PS line. Pass ps as one line of at most 25 words with no link, offering an easy second route that fits them (reply "call", or a question answered in one word). Leave ps out to keep the template\'s own PS.');
  }
  if (hasAsset) {
    notes.push("Live booking times appear only when the access asset is carried and the person's temperature allows it; otherwise the fixed text asks them to reply with a time. Never propose times yourself.");
  }
  return { template_key: key, parts, note: notes.join(" ") };
}
