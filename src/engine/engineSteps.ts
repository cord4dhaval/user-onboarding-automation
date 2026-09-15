import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

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
  part: "subject" | "preheader" | "heading" | "fixed" | "your_words" | "ps" | "asset" | "cta" | "opt_out";
  text?: string;
  instruction?: string;
  fallback?: string;
  tier?: string;
}

export interface Skeleton {
  template_key: string;
  parts: SkeletonPart[];
  note: string;
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
    } else if (type === "slot") {
      hasSlot = true;
      parts.push({ part: "your_words", instruction: str(raw.instruct) ?? str(raw.instruction), fallback: str(raw.fallback) });
    } else if (type === "asset") {
      hasAsset = true;
      parts.push({ part: "asset", tier: str(raw.tier), text: str(raw.ref) ? `pinned: ${String(raw.ref)}` : "the asset you carry, if any" });
    } else if (type === "cta") parts.push({ part: "cta", text: str(raw.fixed) ?? str(raw.label) });
    else if (type === "system") parts.push({ part: "opt_out" });
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
