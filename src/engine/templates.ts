import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { ProductConfig } from "../schemas/product.js";

/**
 * Builds the starter template set for a product from its config alone: the whole stage
 * ladder per suggested channel, plus a segment variant of the opener wherever a segment
 * names a distinct pain.
 *
 * These are deterministic so a brand-new product can send its first touch immediately,
 * before any Claude session has run — and so a sequence does not run dry on day three
 * waiting for a model. They are honest but plain; Claude replaces them through
 * upsert_template, and a human edits them in the editor. Nothing here is final.
 */
/** Config values are written mid-sentence; a fallback has to start like a sentence. */
const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/**
 * The stages a trial actually has. One welcome is not a sequence — it is an opening line
 * followed by silence, which is how most onboarding mail fails.
 */
interface Rung {
  key: string;
  name: string;
  stage: string;
  /** What this message is for, handed to Claude as the slot instruction. */
  angle: (config: ProductConfig) => string;
  subject: (config: ProductConfig) => string;
  heading: (config: ProductConfig) => string;
  body: (config: ProductConfig) => string;
}

const firstPropOf = (config: ProductConfig) => config.valueProps[0] ?? "get started in minutes";

const LADDER: Rung[] = [
  {
    key: "welcome",
    name: "Welcome",
    stage: "first_touch",
    angle: (c) => `Two sentences on what they can do in the first ten minutes. Tone: ${c.voice.tone}. No filler.`,
    subject: () => "{{first_name}}, your workspace is ready",
    heading: () => "Your workspace is ready",
    body: (c) => `${sentence(firstPropOf(c))}\n\nMost teams see something useful inside a day.`,
  },
  {
    key: "activation_nudge",
    name: "Activation nudge",
    stage: "day_two",
    angle: (c) =>
      `They signed up and stopped. Name the one thing standing between them and "${c.activation.describedAs}", and make that one thing feel small.`,
    subject: () => "{{first_name}}, one step left",
    heading: () => "One step left",
    body: (c) =>
      `You are one step from ${c.activation.describedAs}.\n\nIt takes a couple of minutes, and you can undo it afterwards.`,
  },
  {
    key: "value_proof",
    name: "Value proof",
    stage: "day_four",
    angle: (c) =>
      `Still cold. Show evidence rather than claims — what a team like theirs actually saw. Stay inside: ${c.valueProps.join("; ")}.`,
    subject: () => "What this looks like in week one",
    heading: () => "What this looks like in week one",
    body: (c) => `${sentence(firstPropOf(c))}\n\nThat is the whole first week. No rollout, no training day.`,
  },
  {
    key: "objection",
    name: "Objection",
    stage: "day_seven",
    angle: (c) =>
      `They have gone quiet. Name the objection their segment actually has and answer it straight. Never claim: ${c.constraints.forbiddenClaims.join("; ") || "anything the product cannot back"}.`,
    subject: () => "The bit people usually ask about",
    heading: () => "The bit people usually ask about",
    body: () =>
      "Most people stall on the same question, so here is the straight answer rather than a brochure one.",
  },
  {
    key: "last_call",
    name: "Last call",
    stage: "day_twelve",
    angle: () =>
      "The trial is ending. Be honest about that and easy to say no to. No manufactured urgency, no countdown.",
    subject: () => "{{first_name}}, your trial ends soon",
    heading: () => "Your trial ends soon",
    body: () =>
      "If it is not useful, that is a fair answer and this is the last you will hear about it.\n\nIf it is, the link below picks up exactly where you left off.",
  },
];

/**
 * Rungs a sequence never climbs to, because they are reached by what a person did rather
 * than by how far through the sequence they are.
 *
 * Kept out of `LADDER` on purpose. Handing someone a way to reach us is not a position — it
 * can be earned on day two or day eleven — and a rung inside the ladder would be walked
 * into by anybody who simply received enough messages, which is exactly the thing this is
 * meant to be an answer to.
 */
const STATE_RUNGS: Rung[] = [
  {
    key: "access",
    name: "Access",
    stage: "earned",
    angle: () =>
      "They have earned a conversation: they clicked recently, or they wrote back. Say that you noticed, " +
      "offer the time, and stop. No pitch, no recap, nothing to read before deciding.",
    subject: () => "{{first_name}}, worth twenty minutes?",
    heading: () => "Worth twenty minutes?",
    body: () =>
      "You have been looking at this properly, so rather than send you more to read, here is time with someone who can answer whatever is still open." +
      "\n\nNo deck, no demo you have already seen.",
  },
];

/** The ladder as plain keys, in the order a sequence climbs them. */
export const LADDER_KEYS = LADDER.map((rung) => rung.key);

/** Reached by state, never by position. */
export const STATE_RUNG_KEYS = STATE_RUNGS.map((rung) => rung.key);
export const ACCESS_RUNG = "access";

export interface TemplatePick {
  orgId: string;
  productId: string;
  /** Channel key the action is going out on. A template for another channel is no use. */
  channel: string;
  /** Prefers a segment-scoped variant where the person has a segment and one exists. */
  segment?: string;
  /**
   * How many touches this campaign has already spent on this person. The Nth message
   * climbs to the Nth rung, which is the only reading of "which stage" that holds when a
   * plan numbers its own steps however it likes.
   */
  touchesSpent?: number;
  /**
   * Rungs this person has already been sent. A counter alone cannot see them: a touch that
   * failed, or one sent before the counter caught up, leaves the next message pointing at
   * a rung the reader has already had — which is how a lead who had read the welcome and
   * clicked it received the welcome a second time.
   */
  usedKeys?: string[];
  /**
   * Ask for one particular rung rather than climbing to one.
   *
   * Used by the messages that exist because of something a person did. The climb is about
   * how far through a sequence they are, and a message that fires because they went hot is
   * not part of that sequence at all.
   */
  rungKey?: string;
}

/**
 * The template a touch should render through, for actions that do not name one.
 *
 * Only the first touch is queued with a template id: it is chosen at ingest, before any
 * session has run, from the goal's `firstTouch.templateKey`. Every later touch is written
 * by a Claude session that supplies the copy for the slot and has no reason to know which
 * skeleton it lands in — the greeting, the call to action and the opt-out block are the
 * template's, and which template that is depends on how far through the sequence the
 * person is, which is only knowable at send time.
 *
 * Resolving it here rather than at compose time also means a plan rewritten between
 * writing and sending still renders through the right rung.
 */
export async function resolveTemplateFor(pick: TemplatePick): Promise<Document | null> {
  const db = await getDb();
  const candidates = await db
    .collection(C.templates)
    .find({ orgId: pick.orgId, productId: pick.productId, channel: pick.channel, status: "active" })
    .toArray();
  if (candidates.length === 0) return null;

  const used = new Set(pick.usedKeys ?? []);

  // Named rung wins outright, and falls back to nothing rather than to the ladder. A
  // message asking for the access rung is asking to hand over a calendar; quietly sending
  // the day-four value proof instead would be a different message to a different purpose.
  if (pick.rungKey) {
    const named = candidates.filter((t) => String(t.key) === pick.rungKey);
    if (named.length === 0) return null;
    return (
      (pick.segment && named.find((t) => t.scope === "segment" && t.segmentKey === pick.segment)) ||
      named.find((t) => t.scope === "product_default") ||
      named[0] ||
      null
    );
  }

  const start = Math.min(Math.max(pick.touchesSpent ?? 0, 0), LADDER_KEYS.length - 1);
  // Climb past any rung this person has already been sent. Repeating one is worse than
  // skipping ahead: the same words twice reads as a broken system, whereas arriving at the
  // day-seven message early only reads as brisk.
  const rung =
    LADDER_KEYS.slice(start).find((key) => !used.has(key)) ??
    // Everything above is spent, so fall back down to anything unsent before giving up and
    // repeating — a later message is still closer to a conversation than the opener again.
    [...LADDER_KEYS].reverse().find((key) => !used.has(key)) ??
    LADDER_KEYS[start]!;
  const atRung = candidates.filter((t) => String(t.key) === rung);

  // The cascade is the same one ingest uses, applied twice: first among templates for the
  // rung this person has climbed to, then among everything on the channel. A product
  // missing its day-seven rung falls back to a template that exists rather than to
  // nothing, because a plain message that goes out beats a designed one that does not.
  const cascade = (pool: Document[]) =>
    (pick.segment && pool.find((t) => t.scope === "segment" && t.segmentKey === pick.segment)) ||
    pool.find((t) => t.scope === "product_default") ||
    pool[0];

  // The wide fallback skips spent rungs too, or the exclusion above is undone by the very
  // next line whenever a rung has no template of its own.
  const unspent = candidates.filter((t) => !used.has(String(t.key)));
  return cascade(atRung) ?? cascade(unspent) ?? cascade(candidates) ?? null;
}

export async function generateDefaultTemplates(
  orgId: string,
  productId: string,
  config: ProductConfig,
): Promise<number> {
  const db = await getDb();
  const firstProp = config.valueProps[0] ?? "get started in minutes";
  let written = 0;

  for (const suggestion of config.suggestedChannels) {
    const isShortForm = suggestion.key !== "email";

    for (const rung of [...LADDER, ...STATE_RUNGS]) {
      // Short-form channels carry the opener and nothing else. A five-message SMS
      // sequence is not a sequence, it is a reason to block the number.
      if (isShortForm && rung.key !== "welcome") continue;

      // A rung reached by state carries whatever earned it and nothing else. The access
      // rung's whole job is to hand over a calendar, and the calendar arrives as an asset —
      // so a "Get started" button under it would offer a second, smaller decision beside
      // the one being asked for.
      const stateRung = STATE_RUNG_KEYS.includes(rung.key);

      const blocks: Record<string, unknown>[] = [];
      if (!isShortForm) {
        blocks.push({
          type: "subject",
          slot: `${rung.name.toLowerCase()}, under 55 characters`,
          fallback: rung.subject(config),
        });
        // The line the inbox shows beside the subject. Left to the client it becomes the
        // first words of the greeting, which wastes the second-best asset an email has.
        blocks.push({
          type: "preheader",
          slot: "one line on what is inside, under 90 characters, not a repeat of the subject",
          fallback: `${sentence(firstProp)} — nothing to set up first.`,
        });
        blocks.push({ type: "heading", level: 1, slot: `${rung.key}_headline`, fallback: rung.heading(config) });
      }
      blocks.push({ type: "text", fixed: "Hi {{first_name}}," });
      blocks.push({
        type: "slot",
        instruct: rung.angle(config),
        fallback: isShortForm ? firstProp : rung.body(config),
      });
      // Three concrete steps read as a plan; a paragraph describing them reads as
      // marketing. Only on the opener, and only where there is something to list.
      //
      // The opening paragraph already leads on the first value prop, so the list starts
      // at the second. Repeating it put the same sentence twice in one short email, once
      // as prose and once as a tick.
      if (!isShortForm && rung.key === "welcome" && config.valueProps.length > 1) {
        blocks.push({ type: "list", style: "check", items: config.valueProps.slice(1, 4).map(sentence) });
      }
      if (!stateRung) {
        blocks.push({ type: "cta", fixed: rung.key === "last_call" ? "Pick up where you left off" : "Get started", url: config.trialLinkTemplate });
      }
      if (!isShortForm) blocks.push({ type: "system", fixed: "opt_out_block" });

      await db.collection(C.templates).updateOne(
        { orgId, productId, key: rung.key, channel: suggestion.key, scope: "product_default" },
        {
          $set: {
            orgId,
            productId,
            key: rung.key,
            name: rung.name,
            channel: suggestion.key,
            format: isShortForm ? "text" : "html",
            stage: rung.stage,
            scope: "product_default",
            version: 1,
            blocks,
            constraints: {
              maxWords: isShortForm ? 45 : 140,
              readingLevel: config.voice.readingLevel,
              noClaims: config.constraints.forbiddenClaims,
            },
            assetIds: [],
            stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
            status: "active",
            createdBy: "claude",
          },
          $setOnInsert: { _id: new ObjectId() },
        },
        { upsert: true },
      );
      written++;
    }

    // A segment whose pain differs enough to deserve its own opening gets a variant that
    // overrides the default through the cascade. Only the opener: past the first message
    // the sequence has earned enough context that a segment-wide angle adds little.
    for (const segment of config.segments) {
      if (!segment.preferredChannels.includes(suggestion.key)) continue;

      await db.collection(C.templates).updateOne(
        { orgId, productId, key: "welcome", channel: suggestion.key, scope: "segment", segmentKey: segment.key },
        {
          $set: {
            orgId,
            productId,
            key: "welcome",
            name: `Welcome — ${segment.name}`,
            channel: suggestion.key,
            format: isShortForm ? "text" : "html",
            stage: "first_touch",
            scope: "segment",
            segmentKey: segment.key,
            version: 1,
            blocks: [
              ...(isShortForm
                ? []
                : [
                    {
                      type: "subject",
                      slot: `hook on "${segment.pain}", under 55 characters`,
                      fallback: `{{first_name}}, about ${segment.pain}`,
                    },
                    {
                      type: "preheader",
                      slot: `one line on how ${segment.useCase} changes that, under 90 characters`,
                      fallback: sentence(segment.useCase),
                    },
                    { type: "heading", level: 1, slot: "segment_headline", fallback: sentence(segment.pain) },
                  ]),
              { type: "text", fixed: "Hi {{first_name}}," },
              {
                type: "slot",
                instruct: `Open on their pain: ${segment.pain}. Then how ${segment.useCase} addresses it. Pre-empt: ${segment.objections[0] ?? "setup effort"}.`,
                fallback: `${sentence(segment.useCase)}, without the spreadsheet gymnastics.`,
              },
              { type: "cta", fixed: "Get started", url: config.trialLinkTemplate },
              ...(isShortForm ? [] : [{ type: "system", fixed: "opt_out_block" }]),
            ],
            constraints: {
              maxWords: isShortForm ? 45 : 140,
              readingLevel: config.voice.readingLevel,
              noClaims: config.constraints.forbiddenClaims,
            },
            assetIds: [],
            stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
            status: "active",
            createdBy: "claude",
          },
          $setOnInsert: { _id: new ObjectId() },
        },
        { upsert: true },
      );
      written++;
    }
  }

  return written;
}
