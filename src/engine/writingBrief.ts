import type { Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { evidenceStatus, ideaPerformance, themePerformance } from "./outcomes.js";
import { TRIAL_LEADS, ideaLeadCount, ideaLimitsFor, ideaRecords, ideaUsage, ideasFor, ideasHadBy, ideasLoopOn, rankIdeas } from "./ideas.js";
import { FORMAT_CHOICE, FRAME_BODY_MAX_WORDS, IDEAS_ARE_TEACHING, LAYOUT_TESTS, LEAD_TYPE_PROFILES, ROLLING_MAX_STEPS, SENTENCE_MAX_WORDS, WATCH_WINDOW_MS, effectiveBand, frameKeyOf, groupFor, layoutArm, leadTypeOf } from "./rolling.js";

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
  lead_type: { type: string; label: string; who: string; paced_as: string | null; default_ask: string; reply_ask_only_for_hooks: string[]; body_max_words: number; sequence: Array<{ hook: string; job: string; sent: boolean }> | null; rules: string[] } | null;
  max_steps_per_plan: number;
  body_max_words: number;
  watch_hours: Record<string, number>;
  group: string;
  their_words: Record<string, unknown>;
  facts: unknown;
  examples: string[];
  examples_note: string;
  ideas: {
    note: string;
    best_fit: Array<{ n: number; title: string; detail?: string; pattern?: string; also?: string[]; hook: string; proof: string; plan?: string; card?: string; used_this_week: number; record?: string; source?: string; status?: string }>;
    others: string[];
    used_a_lot_this_week: number[];
    already_had: number[];
  } | null;
  subject_avoid: string[];
  product_in_one_line: string | null;
  plain_words: Array<{ word: string; use: string }>;
  phrases: string[];
  hook_examples: string[];
  themes_sent: Array<Record<string, unknown>>;
  similar_leads: Array<Record<string, unknown>>;
  learning_notes: Array<Record<string, unknown>>;
  exploration: { recent_sends: number; first_tries: number; note: string };
  layout_tests: Array<{ test: string; arm: string; rule: string }>;
  rules: string[];
}

export async function writingBriefFor(input: {
  orgId: string;
  productId: string;
  person: Document;
  goal: Document | null;
  product: Document | null;
  actions: Document[];
  /** The lead's run of this campaign, so the idea bank can be ranked against the rest of it. */
  goalInstanceId?: string;
  goalKey?: string;
}): Promise<WritingBrief> {
  const { orgId, productId, person, goal, product, actions } = input;
  const db = await getDb();
  const writing = ((product?.config as { writing?: Record<string, unknown> } | undefined)?.writing ?? {}) as {
    facts?: unknown;
    examples?: string[];
    subjectAvoid?: string[];
    oneLine?: string;
    wordsAvoid?: Array<{ word: string; use: string }>;
    phrases?: string[];
    hookExamples?: string[];
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

  // The idea bank, ranked for this lead, when the product's ideas are tagged. Ten random
  // examples are only the fallback for a product whose ideas are not.
  const loop = ideasLoopOn();
  let bank = ideasFor(product, loop);
  let ideas: WritingBrief["ideas"] = null;
  if (bank.length && input.goalInstanceId && input.goalKey) {
    const [usage, had, limits, results] = await Promise.all([
      ideaUsage({ orgId, productId, goalKey: input.goalKey, excludeInstanceId: input.goalInstanceId }),
      ideasHadBy({ orgId, goalInstanceId: input.goalInstanceId }),
      ideaLimitsFor({ orgId, productId, goalKey: input.goalKey, bank }),
      loop ? ideaPerformance(orgId, productId) : Promise.resolve(null),
    ]);
    // A trial idea that has reached its few leads waits for their results before anyone else gets it.
    for (const idea of bank.filter((i) => i.status === "trial")) {
      if ((await ideaLeadCount({ orgId, productId, n: idea.n, excludeInstanceId: input.goalInstanceId })) >= TRIAL_LEADS) bank = bank.filter((i) => i.n !== idea.n);
    }
    const leadText = [form.main_problem, form.role, person.role, form.team_size, (person.enrichment as { siteText?: unknown } | undefined)?.siteText]
      .map((v) => String(v ?? ""))
      .join(" ")
      .slice(0, 2000);
    const ranked = rankIdeas(bank, { text: leadText, segment: (person.belief as { segment?: string } | undefined)?.segment }, usage, had, limits, results ? ideaRecords(results, group) : undefined);
    const fresh = ranked.filter((i) => !i.already_had);
    ideas = {
      note: loop
        ? `${IDEAS_ARE_TEACHING} best_fit is ranked for this lead from their words and segment and from what each idea has earned (record: sends, clicks and replies, from leads like this one once there are a few), with ideas the campaign leaned on this week pushed down and untested ones given a small push. Your own reading of the lead matters more than the rank. You may blend two ideas. If no pattern here fits this lead, call propose_idea with a new one built on a verified fact, then plan with the number it returns: a new idea reaches 5 leads, and their results decide whether it stays.`
        : `${IDEAS_ARE_TEACHING} best_fit is ranked for this lead from their words and segment, with ideas the campaign leaned on this week pushed down. You may blend two ideas; name every idea you learned from.`,
      best_fit: fresh.slice(0, 8).map((i) => ({
        n: i.n, title: i.title, detail: i.detail, pattern: i.pattern, also: i.also, hook: i.hook, proof: i.proof, plan: i.plan, card: i.card, used_this_week: i.used_this_week,
        ...(i.record ? { record: i.record } : {}),
        ...(i.source ? { source: i.source, status: i.status } : {}),
      })),
      others: fresh.slice(8).map((i) => `#${i.n} ${i.title} (${i.hook}${i.used_this_week ? `, used by ${i.used_this_week} this week` : ""})`),
      used_a_lot_this_week: [...usage.entries()].filter(([, count]) => count >= limits.busyAt).map(([n]) => n).sort((a, b) => a - b),
      already_had: [...had].sort((a, b) => a - b),
    };
  }
  const examples = ideas ? [] : shuffle((writing.examples ?? []).map(String)).slice(0, EXAMPLES_SHOWN);

  return {
    mode: "rolling",
    frame_key: frameKeyOf(goal),
    // Read first: it decides how hard every touch pushes.
    lead_type: (() => {
      const type = leadTypeOf(goal);
      if (!type) return null;
      const profile = LEAD_TYPE_PROFILES[type];
      return {
        type,
        label: profile.label,
        who: profile.who,
        paced_as: effectiveBand((person.temp as { band?: string } | undefined)?.band, type, form.timeline) ?? null,
        default_ask: profile.ask,
        reply_ask_only_for_hooks: profile.replyHooks,
        body_max_words: profile.maxWords,
        // Which jobs this lead has already had, so the next plan takes the next one.
        sequence: profile.sequence
          ? profile.sequence.map((s) => ({ ...s, sent: actions.some((a) => String(a.hook ?? "") === s.hook && ["sent", "dispatched"].includes(String(a.status))) }))
          : null,
        rules: profile.rules,
      };
    })(),
    max_steps_per_plan: ROLLING_MAX_STEPS,
    body_max_words: leadTypeOf(goal) ? LEAD_TYPE_PROFILES[leadTypeOf(goal)!].maxWords : FRAME_BODY_MAX_WORDS,
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
    ideas,
    examples_note:
      "A random sample of past ideas, shown for the standard a message should clear. They are not a menu: invent the idea that fits this person, and use one of these only if it truly is the best fit.",
    subject_avoid: (writing.subjectAvoid ?? []).map(String),
    product_in_one_line: writing.oneLine ? String(writing.oneLine) : null,
    plain_words: (writing.wordsAvoid ?? []).map((w) => ({ word: String(w.word), use: String(w.use) })),
    // Words the reader's office really uses, and emails that clear the bar for a hot lead.
    // The examples show the shape and the "no way" moment; they are not templates.
    phrases: (writing.phrases ?? []).map(String),
    hook_examples: (writing.hookExamples ?? []).map(String),
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
    // This lead's fixed arm in each layout test, so the writer follows it and the results
    // compare groups of leads (docs/learnings.md PT8).
    layout_tests: LAYOUT_TESTS.map((test) => {
      const arm = layoutArm(String(person._id), test);
      return {
        test,
        arm,
        rule:
          test === "reply_options"
            ? arm === "use"
              ? "Every reply ask to this lead carries reply_options: 2 to 4 short answers to the question, shown as \"Reply with one number:\" and numbered lines."
              : "This lead is in the hold-out group: no reply_options."
            : arm === "use"
              ? "Every story idea (hook \"story\") for this lead carries a timeline: 2 to 4 moments in order, a day or time and one short sentence each."
              : "This lead is in the hold-out group: no timeline; tell the story in the scene.",
      };
    }),
    rules: [
      "Write so a busy owner understands it in one quick read, the way a clear professional would explain it across a desk.",
      "Say what the product is once, in plain words close to product_in_one_line, usually as the line above what they would see. Never assume they already know.",
      `Short sentences, one idea each, never more than ${SENTENCE_MAX_WORDS} words. Everyday words: no wordplay, no metaphors, no clever phrasing. Where plain_words lists a word, use its plain replacement.`,
      "Name the problem the way they would say it (\"orders wait for approval\"), not in our words (\"work is blocked\").",
      `Plan at most ${ROLLING_MAX_STEPS} touches. The engine watches the result and asks again.`,
      "Invent the idea for this person: a real moment from their week, with its cost in rupees or hours.",
      "State only what product_config.writing.facts supports. Never quote anything in facts.unverified.",
      "A number that is not a fact is an example, and the sentence says so ('for example', 'a team of 30 on ₹25,000').",
      "Never print their company's name or any person's name. Describe what they do instead.",
      "Never say how they arrived or point back at what they submitted: no 'you clicked', 'you signed up', 'you asked', 'you named', 'you mentioned', 'your form'. Write about their situation as a fact of their business.",
      "Segment off_icp: one short touch that asks a question a person can answer in a line (what the team mostly does at a computer, for example), no pitch.",
      "Where the fit is partial, say the limit plainly (for example: work away from a computer is not recorded).",
      "Professional register: complete sentences, no contractions, first person plural.",
      "lead_type comes first: where it is set, its default_ask and rules decide what every touch asks for.",
      FORMAT_CHOICE,
      "One ask: a reply question, or the button. Never both.",
      "Write in parts, not one block: opening (one sentence under 90 characters), scene (one or two short paragraphs, at most two **bold** phrases), cost_lines (up to 3: label under 40 characters, value under 50), shows (up to 3 lines under 50 characters), limit (one line, only where the fit is partial), question (one line), plus the timeline or reply_options your layout_tests arm asks for. The frame makes the cost lines a tinted box and the list a check list in HTML, and a label with an arrow line under it and dashes in plain text.",
      `The whole body, lists and titles included, stays within ${leadTypeOf(goal) ? LEAD_TYPE_PROFILES[leadTypeOf(goal)!].maxWords : FRAME_BODY_MAX_WORDS} words.`,
      "Write quantities as digits: 5 days, 9 hours, 3 of 9 hours, 30 people, ₹4 lakh. A skimming eye stops on digits and passes over words.",
      "In plain text there is no hidden preview line: the inbox shows the opening after the subject. Make the opening add to the subject, never repeat it.",
      "Only these symbols: → – × ÷ = ₹ • ✓. Never ✔ ☑ ➡ ▶ ⚠ ™ or other symbols phones turn into emoji, never styled Unicode letters, no capitals for emphasis, no emoji.",
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
