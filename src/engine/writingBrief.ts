import type { Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { evidenceStatus, themePerformance } from "./outcomes.js";
import { FRAME_BODY_MAX_WORDS, ROLLING_MAX_STEPS, WATCH_WINDOW_MS, frameKeyOf, groupFor } from "./rolling.js";

/**
 * What a session planning or writing one touch in a rolling campaign reads, in one block.
 *
 * Four things, in the order a writer needs them: who this person is in their own words,
 * what the product can truthfully say, what has already been said to them and what came of
 * it, and what has worked or failed for leads like them. The examples are a sample of the
 * quality bar, reshuffled on every card so no handful of them becomes the menu.
 */

const EXAMPLES_SHOWN = 10;

export interface WritingBrief {
  mode: "rolling";
  frame_key: string;
  max_steps_per_plan: number;
  body_max_words: number;
  watch_hours: Record<string, number>;
  group: string;
  their_words: Record<string, unknown>;
  facts: unknown;
  examples: string[];
  examples_note: string;
  subject_avoid: string[];
  themes_sent: Array<Record<string, unknown>>;
  similar_leads: Array<Record<string, unknown>>;
  learning_notes: Array<Record<string, unknown>>;
  exploration: { recent_sends: number; first_tries: number; note: string };
  rules: string[];
}

export async function writingBriefFor(input: {
  orgId: string;
  productId: string;
  person: Document;
  goal: Document | null;
  product: Document | null;
  actions: Document[];
}): Promise<WritingBrief> {
  const { orgId, productId, person, goal, product, actions } = input;
  const db = await getDb();
  const writing = ((product?.config as { writing?: Record<string, unknown> } | undefined)?.writing ?? {}) as {
    facts?: unknown;
    examples?: string[];
    subjectAvoid?: string[];
  };
  const group = groupFor(person);
  const form = ((person.enrichment as { form?: Record<string, unknown> } | undefined)?.form ?? {}) as Record<string, unknown>;

  const [rows, notes, groupSends] = await Promise.all([
    themePerformance(orgId, productId, group),
    db
      .collection(C.learningNotes)
      .find({ orgId, productId, status: { $ne: "retired" }, group: { $in: [group, "all"] } })
      .sort({ updatedAt: -1 })
      .limit(12)
      .project({ _id: 0, key: 1, group: 1, finding: 1, themes: 1, evidence: 1, status: 1, updatedAt: 1 })
      .toArray(),
    db
      .collection(C.actions)
      .find(
        { orgId, productId, status: { $in: ["sent", "dispatched"] }, dryRun: { $ne: true }, "variant.group": group, "variant.theme": { $type: "string" } },
        { projection: { angle: 1, sentAt: 1 } },
      )
      .sort({ sentAt: 1 })
      .limit(500)
      .toArray(),
  ]);

  // Of this group's most recent written touches, how many were an idea's first outing here.
  const seen = new Set<string>();
  const firstTry: boolean[] = [];
  for (const a of groupSends) {
    const angle = String(a.angle);
    firstTry.push(!seen.has(angle));
    seen.add(angle);
  }
  const recent = firstTry.slice(-20);
  const firstTries = recent.filter(Boolean).length;

  const retired = await db
    .collection(C.learningNotes)
    .find({ orgId, productId, status: "retired", group: { $in: [group, "all"] } })
    .project({ _id: 0, themes: 1, finding: 1 })
    .limit(20)
    .toArray();

  const examples = shuffle((writing.examples ?? []).map(String)).slice(0, EXAMPLES_SHOWN);

  return {
    mode: "rolling",
    frame_key: frameKeyOf(goal),
    max_steps_per_plan: ROLLING_MAX_STEPS,
    body_max_words: FRAME_BODY_MAX_WORDS,
    watch_hours: Object.fromEntries(Object.entries(WATCH_WINDOW_MS).map(([k, ms]) => [k, ms / 3_600_000])),
    group,
    their_words: {
      role: person.role ?? form.role ?? null,
      team_size: form.team_size ?? null,
      timeline: form.timeline ?? null,
      main_problem: form.main_problem ?? null,
      website: person.companyDomain ?? form.website ?? null,
    },
    facts: writing.facts ?? null,
    examples,
    examples_note:
      "A random sample of past ideas, shown for the standard a message should clear. They are not a menu: invent the idea that fits this person, and use one of these only if it truly is the best fit.",
    subject_avoid: (writing.subjectAvoid ?? []).map(String),
    themes_sent: actions
      .filter((a) => typeof a.theme === "string" && a.theme)
      .map((a) => ({
        theme: a.theme,
        hook: a.hook ?? null,
        format: a.format ?? null,
        ask: (a.content as { ask?: string } | undefined)?.ask ?? "link",
        status: a.status,
        sent_at: a.sentAt ?? null,
        opened: Boolean(a.firstOpenedAt),
        clicked: Boolean(a.firstClickedAt),
        replied: Boolean(a.firstRepliedAt),
      })),
    similar_leads: rows.slice(0, 15).map((r) => ({
      theme: r.theme,
      hook: r.hook,
      format: r.format,
      ask: r.ask,
      layout: r.layout,
      channel: r.channel,
      sent: r.sent,
      clicked: r.clicked,
      replied: r.replied,
      won: r.won,
      click_rate: r.trackable > 0 ? Number((r.clicked / r.trackable).toFixed(3)) : null,
      evidence: evidenceStatus(r),
    })),
    learning_notes: [...notes, ...retired.map((n) => ({ ...n, status: "retired" }))],
    exploration: {
      recent_sends: recent.length,
      first_tries: firstTries,
      note:
        recent.length < 6
          ? "Too few written touches in this group to lean on anything. Try what fits this person best."
          : firstTries * 3 < recent.length
            ? "This group has mostly repeated ideas lately. Unless this person clearly calls for a proven one, try a new idea."
            : "This group is trying enough new ideas. Prefer what has worked where it fits this person.",
    },
    rules: [
      `Plan at most ${ROLLING_MAX_STEPS} touches. The engine watches the result and asks again.`,
      "Invent the idea for this person: a real moment from their week, with its cost in rupees or hours.",
      "State only what product_config.writing.facts supports. Never quote anything in facts.unverified.",
      "A number that is not a fact is an example, and the sentence says so ('for example', 'a team of 30 on ₹25,000').",
      "Never print their company's name or any person's name. Describe what they do instead.",
      "Never say how they arrived or point back at what they submitted: no 'you clicked', 'you signed up', 'you asked', 'you named', 'you mentioned', 'your form'. Write about their situation as a fact of their business.",
      "Segment off_icp: one short touch that asks a question a person can answer in a line (what the team mostly does at a computer, for example), no pitch.",
      "Where the fit is partial, say the limit plainly (for example: work away from a computer is not recorded).",
      "Professional register: complete sentences, no contractions, first person plural.",
      "Choose format with a reason: text for a first written touch to someone who has not clicked or for a reply ask; html when a table, sample or screen carries the idea, or once they have clicked.",
      "One ask: a reply question, or the button. Never both.",
      "Write in parts, not one block: opening (one sentence), scene (one or two short paragraphs, at most two **bold** phrases), cost_lines (up to 3 label/value lines with the rupee example), shows (up to 3 short lines on what they would see), limit (one line, only where the fit is partial), question (one line). The frame makes the cost lines a tinted box and the list a check list in HTML, and aligned arrow lines and dashes in plain text. No capitals for emphasis, no emoji.",
    ],
  };
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
