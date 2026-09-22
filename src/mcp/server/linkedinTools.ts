import { ObjectId, type Document } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { rulesFor, type ChannelRules } from "../../channels/rules.js";
import { claudePlansLinkedIn, linkedinNeed, type LinkedInNeed } from "../../engine/linkedin.js";
import { linkedinTextProblems, sentenceKey, sentencesOf, type LinkedInTextKind } from "../../engine/linkedinWriting.js";
import { ideasFor, ideasHadBy } from "../../engine/ideas.js";
import { themeSlug } from "../../engine/rolling.js";
import { contextForLead, contextOf, linkPageProblem } from "../../engine/siteContext.js";
import { FindRefused, saveLinkedInFind, type FindStatus } from "../../engine/linkedinFind.js";
import { identityValue } from "../../engine/address.js";
import type { ToolCtx, ToolDef } from "./tools.js";

/**
 * The tools routine 6 (LinkedIn) drives. Kept apart from the email tools on purpose: the
 * email planner and writer, and their refusals, are untouched by anything here.
 *
 * The shape follows the channel's rules (src/channels/rules.ts, with each product's
 * overrides): the engine decides when a lead needs a decision, Claude makes it, and every
 * refusal below is a rule a session cannot talk its way past. Nothing here is specific to
 * one product; ideas, voice and facts are read from the product's own settings.
 */

const WEEK_MS = 7 * 86_400_000;

interface LeadContext {
  instance: Document;
  goal: Document;
  product: Document | null;
  person: Document;
  actions: Document[];
  openReplies: Document[];
  rules: ChannelRules;
  need: LinkedInNeed;
}

async function leadContext(goalInstanceId: string, ctx: ToolCtx, now = new Date()): Promise<LeadContext> {
  const db = await getDb();
  if (!ObjectId.isValid(goalInstanceId)) throw new Error("goal_instance_id is not an id");
  const instance = await db.collection(C.goalInstances).findOne({ _id: new ObjectId(goalInstanceId), orgId: ctx.orgId });
  if (!instance) throw new Error("goal instance not found");
  const productId = String(instance.productId);
  const [goal, product, person, actions, openReplies] = await Promise.all([
    db.collection(C.goals).findOne({ orgId: ctx.orgId, productId, key: String(instance.goalKey) }),
    db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId: ctx.orgId }),
    db.collection(C.people).findOne({ _id: new ObjectId(String(instance.personId)) }),
    db.collection(C.actions).find({ orgId: ctx.orgId, goalInstanceId, channel: "linkedin" }).sort({ createdAt: 1, dueAt: 1 }).toArray(),
    db
      .collection(C.events)
      .find({ orgId: ctx.orgId, productId, personId: String(instance.personId), type: "reply_received", channel: "linkedin", handled: false })
      .sort({ ts: 1 })
      .toArray(),
  ]);
  if (!goal || !claudePlansLinkedIn(goal)) throw new Error("this campaign's LinkedIn touches are not planned by Claude; leave it alone");
  if (!person) throw new Error("person not found");
  const rules = rulesFor("linkedin", product);
  return { instance, goal, product, person, actions, openReplies, rules, need: linkedinNeed({ instance, person, actions, openReplies, rules, now }) };
}

/** Sentences other leads were sent (or have waiting) on LinkedIn this week, for the reuse check. */
async function usedSentences(orgId: string, productId: string, personId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .collection(C.actions)
    .find({
      orgId,
      productId,
      channel: "linkedin",
      personId: { $ne: personId },
      status: { $in: ["sent", "queued", "awaiting_approval", "sending"] },
      $or: [{ sentAt: { $gte: new Date(Date.now() - WEEK_MS) } }, { status: { $ne: "sent" } }],
    })
    .project({ "content.bodyMd": 1, "content.slotText": 1 })
    .toArray();
  const out = new Set<string>();
  for (const row of rows) {
    const text = String((row.content as { slotText?: string; bodyMd?: string } | undefined)?.slotText ?? (row.content as { bodyMd?: string } | undefined)?.bodyMd ?? "");
    for (const s of sentencesOf(text)) out.add(sentenceKey(s));
  }
  return out;
}

function sentMessages(actions: Document[]): Document[] {
  return actions.filter((a) => a.op === "message" && a.status === "sent" && a.angle !== "reply");
}

function unansweredCount(person: Document, actions: Document[]): number {
  const lastReply = person.lastReplyAt ? new Date(String(person.lastReplyAt)) : null;
  return sentMessages(actions).filter((a) => !lastReply || new Date(String(a.sentAt)) > lastReply).length;
}

async function frameTemplate(orgId: string, productId: string, goal: Document): Promise<Document> {
  const db = await getDb();
  const key = String((goal.linkedin as { frameKey?: string } | undefined)?.frameKey ?? "li_frame");
  const template = await db.collection(C.templates).findOne({ orgId, productId, key, channel: "linkedin", status: "active" });
  if (!template) {
    throw new Error(`the campaign has no active LinkedIn frame template "${key}" (one slot block); a person has to add it. Nothing was written.`);
  }
  return template;
}

async function linkedinChannelId(orgId: string, productId: string, instance: Document): Promise<string> {
  const db = await getDb();
  if (instance.channelId) {
    const own = await db.collection(C.channels).findOne({ _id: new ObjectId(String(instance.channelId)), key: "linkedin" });
    if (own) return String(own._id);
  }
  const any = await db.collection(C.channels).findOne({ orgId, productId, key: "linkedin", status: "healthy", enabled: { $ne: false } });
  if (!any) throw new Error("no healthy LinkedIn account on this product. Nothing was written.");
  return String(any._id);
}

function refuse(problems: string[]): never {
  throw new Error(`${problems.map((p) => `- ${p}`).join("\n")}\nNothing was written.`);
}

export const LINKEDIN_TOOLS: ToolDef[] = [
  {
    name: "linkedin_card",
    description:
      "Everything needed to decide one lead's next LinkedIn step: what the engine says they need now (find, pick, plan or answer), their LinkedIn state and how their profile was found, every touch and signal on every channel, the channel's rules, the product's voice, facts and ideas (ideas they already had are left out), and how each idea has done on LinkedIn. Read it before save_linkedin, pick_linkedin, plan_linkedin or answer_linkedin.",
    inputSchema: { type: "object", properties: { goal_instance_id: { type: "string" } }, required: ["goal_instance_id"] },
    async handler(args, ctx) {
      const lead = await leadContext(String(args.goal_instance_id), ctx);
      const db = await getDb();
      const { person, product, rules, instance } = lead;
      const personId = String(person._id);
      const productId = String(instance.productId);

      // One history, every channel: what was sent and what they did.
      const [allActions, events] = await Promise.all([
        db
          .collection(C.actions)
          .find({ orgId: ctx.orgId, personId, status: { $in: ["sent", "dispatched", "queued", "awaiting_approval"] } })
          .sort({ sentAt: 1, dueAt: 1 })
          .project({ channel: 1, op: 1, status: 1, sentAt: 1, dueAt: 1, theme: 1, hook: 1, ideaRefs: 1, angle: 1, "content.subject": 1, "content.bodyMd": 1, "content.slotText": 1 })
          .toArray(),
        db.collection(C.events).find({ orgId: ctx.orgId, personId }).sort({ ts: 1 }).project({ type: 1, channel: 1, ts: 1, actionId: 1, "payload.text": 1 }).toArray(),
      ]);

      const had = await ideasHadBy({ orgId: ctx.orgId, goalInstanceId: String(instance._id) });
      const segment = (person.belief as { segment?: string } | undefined)?.segment;
      const ideas = ideasFor(product)
        .filter((idea) => idea.usable !== false && !had.has(Number(idea.n)))
        .sort((a, b) => Number((b.segments ?? []).includes(segment ?? "")) - Number((a.segments ?? []).includes(segment ?? "")))
        .slice(0, 20)
        .map((idea) => ({ n: idea.n, title: idea.title, hook: idea.hook, pattern: idea.pattern, proof: idea.proof, segments: idea.segments }));

      // How each idea has done on LinkedIn for this product: sent, and answered.
      const liSent = await db
        .collection(C.actions)
        .find({ orgId: ctx.orgId, productId, channel: "linkedin", op: "message", status: "sent", "ideaRefs.0": { $exists: true } })
        .project({ ideaRefs: 1 })
        .toArray();
      const answered = new Set(
        (
          await db
            .collection(C.events)
            .find({ orgId: ctx.orgId, productId, type: "reply_received", channel: "linkedin", actionId: { $exists: true } })
            .project({ actionId: 1 })
            .toArray()
        ).map((e) => String(e.actionId)),
      );
      const byIdea = new Map<number, { sent: number; replied: number }>();
      for (const row of liSent) {
        for (const n of (row.ideaRefs ?? []) as number[]) {
          const s = byIdea.get(n) ?? { sent: 0, replied: 0 };
          s.sent++;
          if (answered.has(String(row._id))) s.replied++;
          byIdea.set(n, s);
        }
      }

      const config = (product?.config ?? {}) as Record<string, unknown>;
      const writing = (config.writing ?? {}) as Record<string, unknown>;
      const li = (person.linkedin ?? {}) as Record<string, unknown>;
      const mine = (instance.linkedin ?? {}) as Record<string, unknown>;
      return {
        needs: lead.need,
        lead: {
          name: person.name ?? null,
          role: person.role ?? null,
          company_site: person.companyDomain ?? null,
          // Where they work, when the address says so: the first clue a profile search has.
          email_domain: person.emailKind === "personal" ? null : String(person.primaryEmail ?? "").split("@")[1] || null,
          segment: segment ?? null,
          fit: (person.belief as { icpFit?: number } | undefined)?.icpFit ?? null,
          said: (person.enrichment as { form?: unknown } | undefined)?.form ?? null,
          site_text: String((person.enrichment as { siteText?: string } | undefined)?.siteText ?? "").slice(0, 800) || null,
        },
        linkedin: {
          profile: identityValue(person, "linkedin") || null,
          // How the profile was found, or why none was; see save_linkedin.
          find: person.linkedinFind ?? null,
          invited_at: li.invitedAt ?? null,
          connected_at: li.connectedAt ?? null,
          invite_expired_at: li.inviteExpiredAt ?? null,
          pick: mine.pick ?? null,
          messages_unanswered: unansweredCount(person, lead.actions),
          messages_left: Math.max(0, (rules.maxUnanswered ?? 3) - unansweredCount(person, lead.actions)),
          open_replies: lead.openReplies.map((e) => ({ event_id: String(e._id), at: e.ts, text: (e.payload as { text?: string } | undefined)?.text ?? "" })),
        },
        history: [
          ...allActions.map((a) => ({
            at: a.sentAt ?? a.dueAt,
            channel: a.channel,
            what: a.op ?? (a.channel === "email" ? "email" : "message"),
            status: a.status,
            idea_refs: a.ideaRefs ?? [],
            theme: a.theme ?? null,
            text: String((a.content as { slotText?: string; bodyMd?: string } | undefined)?.slotText ?? (a.content as { bodyMd?: string } | undefined)?.bodyMd ?? "").slice(0, 600),
            subject: (a.content as { subject?: string } | undefined)?.subject ?? null,
          })),
          ...events.map((e) => ({ at: e.ts, channel: e.channel ?? null, what: e.type, answers: e.actionId ?? null, text: (e.payload as { text?: string } | undefined)?.text ?? null })),
        ].sort((x, y) => new Date(String(x.at)).getTime() - new Date(String(y.at)).getTime()),
        rules: {
          writing: rules.writing ?? [],
          chars: rules.targetChars ?? null,
          gap_days: rules.gapDays ?? null,
          max_unanswered: rules.maxUnanswered ?? 3,
          links:
            "Only {{trial_link}}, with ask \"link\": after they have answered, or on the last message allowed. {{first_name}} is the only other field. " +
            "With a link ask, link_page may name a page from product.context (pages_for_this_lead first) that fits them better than the start link: " +
            "their segment's solution page, the comparison with a tool they use, pricing when they asked about cost, security when they asked about data. {{trial_link}} then goes there.",
        },
        product: {
          one_liner: config.oneLiner ?? null,
          voice: config.voice ?? null,
          facts: writing.facts ?? null,
          phrases: writing.phrases ?? null,
          words_avoid: writing.wordsAvoid ?? null,
          // What the product's website says, cut to this lead (engine/siteContext.ts). The
          // truth sheet (facts) wins where they disagree; proof is only ever an example.
          context: contextForLead(contextOf(product), segment),
        },
        ideas,
        linkedin_results_by_idea: [...byIdea.entries()].map(([n, s]) => ({ n, ...s })),
      };
    },
  },

  {
    name: "save_linkedin",
    description:
      "Record the LinkedIn profile you found for this lead. Only when linkedin_card says needs.kind is \"find\". Search the web first: site:linkedin.com/in with their name and company (lead.said, lead.company_site, lead.email_domain), then their first name with the company, or the company's own LinkedIn page and its people. Compare what the result shows with the lead. confidence: sure (name and current company both match), likely (name matches and the company, city or role fits, and nothing contradicts it), unsure (a plausible profile you could not confirm; a person checks it on the lead page), none (nothing found, or only people who are plainly someone else). sure and likely become the lead's profile at once and the card then asks you to pick; unsure waits for a person; none ends LinkedIn for this lead. Never guess a URL you did not see in a result.",
    inputSchema: {
      type: "object",
      properties: {
        goal_instance_id: { type: "string" },
        confidence: { type: "string", enum: ["sure", "likely", "unsure", "none"] },
        url: { type: "string", description: "The profile URL as the result showed it (https://www.linkedin.com/in/...). Not for none." },
        why: { type: "string", description: "One sentence a person reading the lead page understands: what matched, or why nothing did." },
        evidence: { type: "string", description: "What you judged on: the result's title and headline, as shown." },
      },
      required: ["goal_instance_id", "confidence", "why"],
    },
    async handler(args, ctx) {
      const lead = await leadContext(String(args.goal_instance_id), ctx);
      if (lead.need.kind !== "find") refuse([`this lead does not need a profile found now (${lead.need.kind === "wait" || lead.need.kind === "end" ? lead.need.why : lead.need.kind})`]);
      const status = String(args.confidence ?? "");
      if (!["sure", "likely", "unsure", "none"].includes(status)) refuse(['confidence is "sure", "likely", "unsure" or "none"']);
      try {
        const saved = await saveLinkedInFind({
          orgId: ctx.orgId,
          productId: String(lead.instance.productId),
          personId: String(lead.person._id),
          status: status as FindStatus,
          url: args.url ? String(args.url) : undefined,
          why: String(args.why ?? ""),
          evidence: args.evidence ? String(args.evidence) : undefined,
          by: "claude",
        });
        return {
          ...saved,
          next: saved.usable ? "read linkedin_card again: it now asks you to pick" : saved.status === "unsure" ? "a person confirms it on the lead page" : "LinkedIn ends for this lead",
        };
      } catch (err) {
        if (err instanceof FindRefused) refuse(err.problems);
        throw err;
      }
    },
  },

  {
    name: "pick_linkedin",
    description:
      "Decide whether to invite this lead on LinkedIn at all, with the reason in one sentence a person reading the lead page understands. \"skip\" ends their LinkedIn sequence (a company page, a poor fit, someone who should not be contacted). A note is used only where the account can add one (Premium); otherwise the invite goes without a note.",
    inputSchema: {
      type: "object",
      properties: {
        goal_instance_id: { type: "string" },
        decision: { type: "string", enum: ["invite", "skip"] },
        why: { type: "string" },
        note: { type: "string", description: "Optional invite note, under the account's note limit, no link." },
      },
      required: ["goal_instance_id", "decision", "why"],
    },
    async handler(args, ctx) {
      const lead = await leadContext(String(args.goal_instance_id), ctx);
      if (lead.need.kind !== "pick") refuse([`this lead does not need a pick now (${lead.need.kind === "wait" || lead.need.kind === "end" ? lead.need.why : lead.need.kind})`]);
      const why = String(args.why ?? "").trim();
      if (!why) refuse(["say why, in one sentence"]);
      const decision = String(args.decision);
      if (decision !== "invite" && decision !== "skip") refuse(['decision is "invite" or "skip"']);
      const db = await getDb();
      const now = new Date();
      const instanceId = lead.instance._id as ObjectId;
      const waiting = lead.actions.filter((a) => ["queued", "awaiting_approval"].includes(String(a.status)));

      if (decision === "skip") {
        await db.collection(C.actions).updateMany(
          { _id: { $in: waiting.map((a) => a._id) } },
          { $set: { status: "skipped", skipReason: `Claude chose not to invite them: ${why}` } },
        );
        await db.collection(C.goalInstances).updateOne(
          { _id: instanceId },
          { $set: { "linkedin.pick": "skip", "linkedin.pickWhy": why, "linkedin.pickedAt": now, status: "failed", outcome: `not invited: ${why}`, endedAt: now } },
        );
        return { decision, skipped_messages: waiting.length };
      }

      // The invite is normally queued when they join the campaign. One that was never queued
      // (the invite template was not active yet) is queued here, or "invite" would leave
      // them waiting on an accept for an invite that does not exist.
      let invite = waiting[0];
      if (!invite && !lead.actions.some((a) => a.status === "sent")) {
        const productId = String(lead.instance.productId);
        const key = String((lead.goal.firstTouch as { templateKey?: string } | undefined)?.templateKey ?? "li_invite");
        const template = await db.collection(C.templates).findOne({ orgId: ctx.orgId, productId, key, channel: "linkedin", status: "active" });
        if (!template) refuse([`the campaign's invite template "${key}" is not active; a person has to turn it on`]);
        const goalInstanceId = String(instanceId);
        const row = {
          _id: new ObjectId(),
          orgId: ctx.orgId,
          productId,
          goalInstanceId,
          personId: String(lead.person._id),
          channel: "linkedin",
          channelId: await linkedinChannelId(ctx.orgId, productId, lead.instance),
          templateId: String(template!._id),
          firstTouch: true,
          angle: "welcome",
          rationale: `Invite for ${String(lead.goal.key)}, queued when Claude chose to invite.`,
          idempotencyKey: `${goalInstanceId}:first_touch:${key}`,
          status: "queued",
          dueAt: now,
          cost: 0,
          signals: [],
          next: {},
          content: { bodyMd: "", personalizationUsed: [], claimsMade: [], wordCount: 0 },
          assetIds: [],
          createdAt: now,
        };
        try {
          await db.collection(C.actions).insertOne(row);
          invite = row;
        } catch {
          // Already queued by a run that got there first; the unique key is the guard.
          invite = (await db.collection(C.actions).findOne({ idempotencyKey: row.idempotencyKey })) ?? undefined;
        }
      }

      // A note only where the account can carry one; checked like any other LinkedIn words.
      const note = String(args.note ?? "").trim();
      let noteUsed = false;
      if (note && invite) {
        const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(String(invite.channelId)) });
        const caps = (channel?.capabilities ?? {}) as { inviteNote?: string; maxNoteLength?: number };
        if (caps.inviteNote === "note") {
          const problems = linkedinTextProblems(note, { rules: { ...lead.rules, targetChars: undefined }, kind: "later", ask: "link", person: lead.person })
            .filter((p) => !/link ask carries/.test(p));
          if (note.length > (caps.maxNoteLength ?? 200)) problems.push(`the note is ${note.length} characters; the limit is ${caps.maxNoteLength ?? 200}`);
          if (/\{\{trial_link\}\}/.test(note)) problems.push("an invite note carries no link");
          if (problems.length) refuse(problems);
          await db.collection(C.actions).updateOne({ _id: invite._id }, { $set: { "content.slotText": note, "content.bodyMd": note } });
          noteUsed = true;
        }
      }
      await db.collection(C.goalInstances).updateOne(
        { _id: instanceId },
        { $set: { "linkedin.pick": "invite", "linkedin.pickWhy": why, "linkedin.pickedAt": now } },
      );
      // The invite was waiting on this decision; it goes in the next sending window.
      if (invite) {
        await db.collection(C.actions).updateOne({ _id: invite._id }, { $set: { dueAt: now }, $unset: { deferReason: "" } });
      }
      return { decision, invite_queued: Boolean(invite), note: noteUsed ? "used" : note ? "not used: this account sends invites without a note" : "none" };
    },
  },

  {
    name: "plan_linkedin",
    description:
      "Plan and write this lead's next one or two LinkedIn messages, each with its words, ask, idea and why. Only when linkedin_card says needs.kind is \"plan\". Each message is checked against the channel's rules (length, one question, no link until they have answered or on the last message, no profile compliments, no sign-off, no company name, no sentence another lead got this week, ideas they have not had) and queued for review; refused whole, with every reason, otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        goal_instance_id: { type: "string" },
        rationale: { type: "string", description: "Two sentences: who they are, and what these messages lead with." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              after_days: { type: "number", description: "Days after the previous touch (the accept, for a first message)." },
              text: { type: "string", description: "The message as sent. {{first_name}} and, with ask \"link\", {{trial_link}} are the only fields." },
              ask: { type: "string", enum: ["reply", "link"] },
              link_page: { type: "string", description: "Optional, link asks only: a page url from linkedin_card product.context that {{trial_link}} goes to instead of the start link." },
              idea_refs: { type: "array", items: { type: "number" } },
              theme: { type: "string", description: "The idea in a few words, for results." },
              hook: { type: "string" },
              why: { type: "string", description: "One sentence a person reading the lead page understands." },
            },
            required: ["after_days", "text", "ask", "why"],
          },
        },
      },
      required: ["goal_instance_id", "rationale", "steps"],
    },
    async handler(args, ctx) {
      const lead = await leadContext(String(args.goal_instance_id), ctx);
      if (lead.need.kind !== "plan") refuse([`this lead does not need a plan now (${lead.need.kind === "wait" || lead.need.kind === "end" ? lead.need.why : lead.need.kind})`]);
      const rationale = String(args.rationale ?? "").trim();
      const steps = (Array.isArray(args.steps) ? args.steps : []) as Array<Record<string, unknown>>;
      const problems: string[] = [];
      if (!rationale) problems.push("the plan needs a rationale in words");
      if (steps.length < 1 || steps.length > 2) problems.push("plan one or two messages; the engine asks again once it sees what they do");

      const { rules, person, actions, instance } = lead;
      const productId = String(instance.productId);
      const sentBefore = sentMessages(actions).length;
      const unanswered = unansweredCount(person, actions);
      const max = rules.maxUnanswered ?? 3;
      if (unanswered + steps.length > max) problems.push(`they have ${unanswered} unanswered messages; at most ${max} in all, so ${Math.max(0, max - unanswered)} more`);

      const bank = ideasFor(lead.product);
      const known = new Map(bank.map((idea) => [Number(idea.n), idea]));
      const had = await ideasHadBy({ orgId: ctx.orgId, goalInstanceId: String(instance._id) });
      const used = await usedSentences(ctx.orgId, productId, String(person._id));
      const hasReplied = Boolean(person.lastReplyAt);

      steps.forEach((step, i) => {
        const label = `message ${i + 1}`;
        const kind: LinkedInTextKind = sentBefore === 0 && i === 0 ? "first" : "later";
        const [gMin, gMax] = rules.gapDays?.[kind === "first" ? "first" : "later"] ?? [0, 30];
        const after = Number(step.after_days);
        if (!Number.isFinite(after) || after < gMin || after > gMax) problems.push(`${label}: after_days is ${String(step.after_days)}; ${kind === "first" ? "a first message" : "a later message"} goes ${gMin} to ${gMax} days after the one before`);
        const ask = step.ask === "link" ? "link" : "reply";
        const lastAllowed = unanswered + i + 1 === max;
        if (ask === "link" && !hasReplied && !lastAllowed) problems.push(`${label}: a link waits until they have answered, or the last message allowed`);
        for (const p of linkedinTextProblems(String(step.text ?? ""), { rules, kind, ask, person, usedSentences: used })) problems.push(`${label}: ${p}`);
        const page = String(step.link_page ?? "").trim();
        const pageProblem = page ? linkPageProblem(lead.product, page, ask) : null;
        if (pageProblem) problems.push(`${label}: ${pageProblem}`);
        if (!String(step.why ?? "").trim()) problems.push(`${label}: say why, in one sentence`);
        const refs = (Array.isArray(step.idea_refs) ? step.idea_refs : []).map(Number).filter(Number.isFinite);
        if (bank.length) {
          if (refs.length === 0) problems.push(`${label}: name the idea it is built on (idea_refs from linkedin_card ideas)`);
          else if (refs.every((n) => !known.has(n) || known.get(n)!.usable === false)) problems.push(`${label}: idea_refs ${refs.join(", ")} are not usable ideas`);
          else if (refs.every((n) => had.has(n))) problems.push(`${label}: they already had idea ${refs.join(", ")}`);
        }
        if (i === 1 && sentencesOf(String(step.text)).some((s) => sentencesOf(String(steps[0]!.text)).some((t) => sentenceKey(t) === sentenceKey(s)))) {
          problems.push(`${label}: repeats a sentence from message 1`);
        }
      });
      if (problems.length) refuse(problems);

      const db = await getDb();
      const now = new Date();
      const template = await frameTemplate(ctx.orgId, productId, lead.goal);
      const channelId = await linkedinChannelId(ctx.orgId, productId, instance);
      const goalInstanceId = String(instance._id);
      const usedIds = new Set(actions.map((a) => Number(a.planStepId)).filter(Number.isFinite));
      let nextId = Math.max(100, ...usedIds) + 1;
      // Gaps count from their last touch (the accept, or our last message), not from when
      // this session happened to run; a due date already past goes in the next window.
      const lastTouch = Math.max(
        new Date(String((person.linkedin as { connectedAt?: Date } | undefined)?.connectedAt ?? 0)).getTime(),
        ...sentMessages(actions).map((a) => new Date(String(a.sentAt)).getTime()),
      );
      let due = new Date(lastTouch || now.getTime());
      const rows = steps.map((step, i) => {
        due = new Date(due.getTime() + Number(step.after_days) * 86_400_000);
        if (i === 0 && due < now) due = now;
        const text = String(step.text).trim();
        const id = nextId++;
        const theme = String(step.theme ?? "").trim();
        return {
          _id: new ObjectId(),
          orgId: ctx.orgId,
          productId,
          goalInstanceId,
          personId: String(person._id),
          planStepId: id,
          channel: "linkedin",
          channelId,
          templateId: String(template._id),
          angle: theme ? themeSlug(theme) : "linkedin_message",
          ...(theme ? { theme } : {}),
          ...(step.hook ? { hook: String(step.hook) } : {}),
          ideaRefs: (Array.isArray(step.idea_refs) ? step.idea_refs : []).map(Number).filter(Number.isFinite),
          rationale: String(step.why),
          status: "queued",
          dueAt: due,
          cost: 0,
          signals: [],
          next: {},
          content: {
            bodyMd: text,
            slotText: text,
            ask: step.ask === "link" ? "link" : "reply",
            ...(String(step.link_page ?? "").trim() ? { linkPage: String(step.link_page).trim() } : {}),
            personalizationUsed: [],
            claimsMade: [],
            wordCount: text.split(/\s+/).length,
          },
          assetIds: [],
          idempotencyKey: `${goalInstanceId}:linkedin:${id}`,
          createdAt: now,
        };
      });

      const planId = new ObjectId();
      await db.collection(C.plans).insertOne({
        _id: planId,
        orgId: ctx.orgId,
        productId,
        goalInstanceId,
        version: now.getTime(),
        steps: steps.map((s, i) => ({ id: rows[i]!.planStepId, channel: "linkedin", after_days: s.after_days, theme: s.theme, idea_refs: rows[i]!.ideaRefs, why: s.why })),
        rationale,
        channel: "linkedin",
        createdBy: "claude",
        createdAt: now,
      });
      await db.collection(C.actions).insertMany(rows);
      await db
        .collection(C.goalInstances)
        .updateOne({ _id: instance._id }, { $set: { currentPlanId: String(planId), "linkedin.plannedAt": now } });
      return { queued: rows.map((r) => ({ id: String(r._id), due: r.dueAt, ask: r.content.ask })), note: "Queued; the campaign's review setting decides whether a person approves them first." };
    },
  },

  {
    name: "answer_linkedin",
    description:
      "Answer a LinkedIn message a lead wrote, in the same conversation. Only when linkedin_card says needs.kind is \"answer\". Answer what they asked, from the product's facts; never invent a capability. ask \"link\" carries {{trial_link}} once. Queued for review under the campaign's setting, and sent outside the usual hours since they are waiting.",
    inputSchema: {
      type: "object",
      properties: {
        goal_instance_id: { type: "string" },
        event_id: { type: "string" },
        text: { type: "string" },
        ask: { type: "string", enum: ["reply", "link"] },
        link_page: { type: "string", description: "Optional, link asks only: a page url from linkedin_card product.context that answers what they asked (pricing, security, a comparison)." },
        why: { type: "string" },
      },
      required: ["goal_instance_id", "event_id", "text", "ask", "why"],
    },
    async handler(args, ctx) {
      const lead = await leadContext(String(args.goal_instance_id), ctx);
      const eventId = String(args.event_id ?? "");
      const event = lead.openReplies.find((e) => String(e._id) === eventId);
      if (!event) refuse([`no unanswered LinkedIn reply ${eventId} for this lead`]);
      const text = String(args.text ?? "").trim();
      const ask = args.ask === "link" ? "link" : "reply";
      const problems = linkedinTextProblems(text, {
        rules: lead.rules,
        kind: "answer",
        ask,
        person: lead.person,
        usedSentences: await usedSentences(ctx.orgId, String(lead.instance.productId), String(lead.person._id)),
      });
      if (!String(args.why ?? "").trim()) problems.push("say why, in one sentence");
      const page = String(args.link_page ?? "").trim();
      const pageProblem = page ? linkPageProblem(lead.product, page, ask) : null;
      if (pageProblem) problems.push(pageProblem);
      if (problems.length) refuse(problems);

      const db = await getDb();
      const now = new Date();
      const productId = String(lead.instance.productId);
      const template = await frameTemplate(ctx.orgId, productId, lead.goal);
      const channelId = await linkedinChannelId(ctx.orgId, productId, lead.instance);
      const actionId = new ObjectId();
      await db.collection(C.actions).insertOne({
        _id: actionId,
        orgId: ctx.orgId,
        productId,
        goalInstanceId: String(lead.instance._id),
        personId: String(lead.person._id),
        channel: "linkedin",
        channelId,
        templateId: String(template._id),
        // An answer, not a campaign touch: no gap, no sending hours, no step number.
        angle: "reply",
        rationale: String(args.why),
        status: "queued",
        dueAt: now,
        cost: 0,
        signals: [],
        next: {},
        content: { bodyMd: text, slotText: text, ask, ...(page ? { linkPage: page } : {}), personalizationUsed: [], claimsMade: [], wordCount: text.split(/\s+/).length },
        assetIds: [],
        answersEventId: eventId,
        idempotencyKey: `${String(lead.instance._id)}:linkedin:answer:${eventId}`,
        createdAt: now,
      });
      await db.collection(C.events).updateOne({ _id: event!._id }, { $set: { handled: true, answeredBy: String(actionId), answeredAt: now } });
      return { queued: String(actionId), note: "Queued; the campaign's review setting decides whether a person approves it first." };
    },
  },
];
