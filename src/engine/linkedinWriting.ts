import type { Document } from "mongodb";
import { rulesFor, type ChannelRules } from "../channels/rules.js";
import { companyTokens } from "./rolling.js";

/**
 * What the engine refuses in a LinkedIn message, whoever wrote it. The channel's rules
 * (src/channels/rules.ts, with the product's overrides) say what good looks like; this is
 * the part of them that can be checked, so a session cannot talk its way past a limit.
 *
 * Returns every problem at once, in words a session can fix from, rather than the first.
 */

export type LinkedInTextKind = "first" | "later" | "answer";

export interface LinkedInTextContext {
  rules: ChannelRules;
  kind: LinkedInTextKind;
  /** "reply" ends on one question and carries no link; "link" carries {{trial_link}} once. */
  ask: "reply" | "link";
  /** The lead, for their company's name, which a message never prints. */
  person?: Document | null;
  /** Sentences already sent to other leads this week, normalised; a message may not reuse one. */
  usedSentences?: Set<string>;
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const RAW_LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|ai|io|co|net|org)\b/i;
const SIGN_OFF = /(^|\n)\s*(best|regards|best regards|kind regards|warm regards|thanks|thank you|cheers|sincerely)[,.!]?\s*(\n.*)?$/i;
/** The only merge fields a LinkedIn message may carry. */
const ALLOWED_FIELDS = new Set(["first_name", "trial_link"]);

/** A sentence as compared for reuse: lower case, words only. */
export function sentenceKey(sentence: string): string {
  return sentence.toLowerCase().replace(/\{\{[^}]+\}\}/g, " ").replace(/[^a-z0-9₹]+/g, " ").trim();
}

export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function linkedinTextProblems(text: string, ctx: LinkedInTextContext): string[] {
  const problems: string[] = [];
  const body = text.trim();
  if (!body) return ["the message is empty"];

  // Measured as the reader sees it: the trial link is a link of about 40 characters.
  const shown = body.replace(/\{\{trial_link\}\}/g, "x".repeat(40)).replace(/\{\{first_name\}\}/g, "Rahul");
  const [min, max] = ctx.rules.targetChars?.[ctx.kind] ?? [1, ctx.rules.maxLength?.message ?? 8000];
  if (shown.length < min || shown.length > max) {
    problems.push(`it is ${shown.length} characters; ${ctx.kind === "first" ? "a first message after an accept" : ctx.kind === "answer" ? "an answer" : "a later message"} is ${min} to ${max}`);
  }

  const fields = [...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!);
  const unknown = fields.filter((f) => !ALLOWED_FIELDS.has(f));
  if (unknown.length) problems.push(`it uses {{${unknown.join("}}, {{")}}; only {{first_name}} and {{trial_link}} exist here`);

  if (RAW_LINK.test(body.replace(/\{\{trial_link\}\}/g, ""))) {
    problems.push("it carries a web address; the only link a message may carry is {{trial_link}}, which the engine fills and tracks");
  }
  const links = (body.match(/\{\{trial_link\}\}/g) ?? []).length;
  const questions = (body.match(/\?/g) ?? []).length;
  if (ctx.ask === "link") {
    if (links !== 1) problems.push("a link ask carries {{trial_link}} exactly once");
  } else {
    if (links > 0) problems.push("a reply ask carries no link; the ask is the question");
    // An answer to their message may simply answer; a message of ours asks one thing.
    if (ctx.kind !== "answer" && (questions !== 1 || !/\?\s*$/.test(body))) {
      problems.push("a reply ask ends on one question they can answer in a line");
    }
  }
  if (questions > 1) problems.push(`it asks ${questions} questions; one per message`);

  if (EMOJI.test(body)) problems.push("it has an emoji");
  if (/\*\*|__|^\s*[-•*]\s/m.test(body)) problems.push("it uses bold or a list; a LinkedIn message is plain sentences");
  if (SIGN_OFF.test(body)) problems.push("it signs off; the product speaks, and no person signs the message");

  // The channel's own list is the tells of automated outreach; anything a product added is
  // its voice (TeamGrid's "no contractions"), and the refusal says which.
  const channelDefaults = new Set(rulesFor("linkedin").banned ?? []);
  for (const pattern of ctx.rules.banned ?? []) {
    const hit = body.match(new RegExp(pattern, "i"));
    if (hit) {
      problems.push(
        channelDefaults.has(pattern)
          ? `it says "${hit[0]}", which reads as automated outreach`
          : `it says "${hit[0]}", which the product's voice does not use`,
      );
    }
  }

  const lower = body.toLowerCase();
  const company = companyTokens(ctx.person).find((token) => lower.includes(token));
  if (company) problems.push(`it names their company ("${company}"); describe what they do instead`);

  if (ctx.usedSentences?.size) {
    const reused = sentencesOf(body).find((s) => {
      const key = sentenceKey(s);
      return key.split(" ").length >= 6 && ctx.usedSentences!.has(key);
    });
    if (reused) problems.push(`"${reused}" went to another lead this week; two leads should not get the same sentence`);
  }
  return problems;
}
