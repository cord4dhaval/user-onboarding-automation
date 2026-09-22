import { z } from "zod";
import { channelKey, objectIdString } from "./common.js";

/**
 * Everything product-specific lives here. The engine, planner, composer and adapters
 * contain no knowledge of any particular product — adding one is this document plus a
 * set of connections, which is the whole generic claim.
 */

export const segment = z.object({
  key: z.string(),
  name: z.string(),
  /** How to recognise this person from enrichment. Claude reads it; humans edit it. */
  detect: z.string(),
  useCase: z.string(),
  pain: z.string(),
  objections: z.array(z.string()).default([]),
  /** Ordered by expected response for this persona, not by what is cheapest. */
  preferredChannels: z.array(channelKey).default(["email"]),
});

/** What kind of page a site page is, so a writer can pick the one that fits a lead. */
export const SITE_PAGE_KINDS = ["home", "feature", "solution", "compare", "pricing", "security", "about", "contact", "demo", "blog", "legal", "other"] as const;

/**
 * What the product's own website says, read from every page and kept in one place.
 *
 * `writing.facts` is the truth sheet a person checked; this is the site, as read. The two
 * differ on purpose: a customer story on a marketing page is something the site shows, not
 * something anyone confirmed, so every proof item arrives as a `sample` and only a person
 * can make it `confirmed`. The page map is what lets a mail send an accounting firm to the
 * accounting page instead of everyone to the same start link.
 */
export const siteContext = z.object({
  overview: z.string().default(""),
  positioning: z.string().default(""),
  pages: z
    .array(
      z.object({
        url: z.string().url(),
        title: z.string(),
        kind: z.enum(SITE_PAGE_KINDS),
        /** One line on what the page shows a reader. */
        summary: z.string().default(""),
        /** Segment keys this page is written for. */
        segments: z.array(z.string()).default([]),
        /** On a comparison page, the competitor it compares against. */
        competitor: z.string().optional(),
      }),
    )
    .default([]),
  proof: z
    .array(
      z.object({
        text: z.string(),
        /** Who the site says it is from, as printed ("COO, fintech, 140 people"). Never put in a mail. */
        who: z.string().optional(),
        kind: z.enum(["quote", "case", "logo", "number", "award"]),
        source: z.string().url(),
        status: z.enum(["sample", "confirmed"]).default("sample"),
      }),
    )
    .default([]),
  competitors: z
    .array(
      z.object({
        name: z.string(),
        /** How the product differs, in the site's own claims. */
        differ: z.array(z.string()).min(1),
        page: z.string().url().optional(),
      }),
    )
    .default([]),
  /** Security and compliance claims: SOC 2, ISO 27001, GDPR, data residency. */
  trust: z.array(z.object({ text: z.string(), source: z.string().url().optional() })).default([]),
  markets: z
    .object({
      home: z.string().optional(),
      served: z.array(z.string()).default([]),
      currency: z.string().optional(),
      languages: z.array(z.string()).default([]),
    })
    .default({}),
  /** When the site was last read, as an ISO string, and how many pages that read covered. */
  readAt: z.string(),
  pagesRead: z.number().int().nonnegative(),
  /** What each read changed, newest first, so a refresh can say what moved. */
  changes: z.array(z.object({ at: z.string(), note: z.string() })).default([]),
});
export type SiteContext = z.infer<typeof siteContext>;

export const productConfig = z.object({
  website: z.string().url().optional(),
  oneLiner: z.string(),
  valueProps: z.array(z.string()).min(1),
  segments: z.array(segment).default([]),

  /**
   * Behavioural, not administrative. Signup is not activation, and an activated trial
   * converts several times better than an inactive one — so this is what goals aim at.
   */
  activation: z.object({
    describedAs: z.string(),
    events: z.array(z.string()).default([]),
  }),

  voice: z.object({
    tone: z.string(),
    do: z.array(z.string()).default([]),
    dont: z.array(z.string()).default([]),
    readingLevel: z.number().int().min(4).max(14).default(8),
  }),

  constraints: z.object({
    maxTouchesPerWeek: z.number().int().positive().default(2),
    quietHours: z.tuple([z.number().int(), z.number().int()]).default([21, 8]),
    forbiddenClaims: z.array(z.string()).default([]),
  }),

  /** What the product wants connected. Suggestions only — the user authorises each one. */
  suggestedChannels: z.array(z.object({
    key: channelKey,
    why: z.string(),
    priority: z.number().int().positive(),
  })).default([]),

  trialLinkTemplate: z.string().default("https://example.com/start?p={{person_id}}"),

  /**
   * This product's overrides of a channel's rules (src/channels/rules.ts): limits, hours,
   * lengths, writing rules. Absent means the channel's defaults, which suit most products.
   */
  channelRules: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),

  /** What the product's website says, page by page. Written by save_context. */
  context: siteContext.optional(),

  /**
   * What a session writing a whole message needs and may not invent.
   *
   * `facts` is the truth sheet: what each plan contains, what the product can do, what it
   * never does, and claims seen somewhere that are not confirmed. `examples` show the bar
   * a message should clear; they are not a menu. `subjectAvoid` is refused in a subject.
   * `oneLine` says what the product is in words a busy owner reads once; a written touch
   * says it so nobody has to already know. `wordsAvoid` pairs a word readers stumble on
   * with the plain one to use, and a written touch that uses the first is refused.
   */
  writing: z
    .object({
      facts: z
        .object({
          plans: z.array(z.object({ name: z.string(), price: z.string(), includes: z.array(z.string()).default([]) })).default([]),
          canDo: z.array(z.object({ text: z.string(), plan: z.string().optional(), source: z.string().optional() })).default([]),
          neverDoes: z.array(z.string()).default([]),
          unverified: z.array(z.string()).default([]),
          /** Sample figures the product's own site shows, quotable only as a sample. */
          samples: z.array(z.string()).default([]),
          /** Published third-party figures, quotable only with their source named. */
          external: z.array(z.object({ text: z.string(), source: z.string() })).default([]),
          limits: z.array(z.string()).default([]),
        })
        .default({}),
      examples: z.array(z.string()).default([]),
      subjectAvoid: z.array(z.string()).default([]),
      oneLine: z.string().optional(),
      /** The short line under the product's name in a letter's signature. */
      signatureLine: z.string().optional(),
      /** Office words the product's readers really use ("any update?", late mark), for the writer. */
      phrases: z.array(z.string()).default([]),
      /** Short emails that clear the bar for a hot lead: the shape and the "no way" moment. */
      hookExamples: z.array(z.string()).default([]),
      /** The idea bank, tagged: the hook that lands each idea, the capability that proves it, its sample card. */
      ideas: z
        .array(
          z.object({
            n: z.number(),
            title: z.string(),
            detail: z.string().optional(),
            hook: z.string(),
            proof: z.string(),
            plan: z.string().optional(),
            card: z.enum(["summary", "apps", "day", "none"]).optional(),
            segments: z.array(z.string()).default([]),
            keywords: z.array(z.string()).default([]),
            usable: z.boolean().default(true),
            note: z.string().optional(),
          }),
        )
        .default([]),
      wordsAvoid: z.array(z.object({ word: z.string(), use: z.string() })).default([]),
    })
    .optional(),
});
export type ProductConfig = z.infer<typeof productConfig>;

export const product = z.object({
  orgId: objectIdString,
  slug: z.string(),
  name: z.string(),
  config: productConfig,
  version: z.number().int().positive().default(1),
  status: z.enum(["draft", "active", "paused"]).default("draft"),
  createdAt: z.date(),
});
export type Product = z.infer<typeof product>;
