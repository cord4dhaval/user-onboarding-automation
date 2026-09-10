import { z } from "zod";
import { channelKey, objectIdString } from "./common.js";

/**
 * A thing we can show someone that is not sentences: a screenshot, a demo video, a case
 * study, a price sheet, a calendar link, a rep's phone number.
 *
 * Assets are stored rather than described because a model that is told to "mention the
 * demo video" will write a URL, and the URL will be wrong. Claude picks an asset by id
 * from a menu the engine computed; the engine renders it. Same split as everywhere else
 * here — the model decides which, the engine decides how, and neither does the other's
 * job.
 */

/**
 * What it costs the reader to receive it, not what it cost us to make.
 *
 * D  ambient      a logo strip, a screenshot. Costs nothing to glance at.
 * C  generic      a case study, a one-pager. Reads in under a minute.
 * B  invested     a demo video, a tailored teardown. Asks for real attention.
 * A  personal     a calendar link, a phone number, a named human.
 *
 * The tiers are a ladder of what we are asking for, which is why `cadenceByTemp` caps them
 * by temperature: sending a calendar link to someone who has never opened anything is not
 * generous, it is a stranger asking for an hour.
 */
export const assetTier = z.enum(["A", "B", "C", "D"]);
export type AssetTier = z.infer<typeof assetTier>;

/**
 * The shape of the thing, which decides how it renders and which channels can carry it.
 * `access` is the odd one out and deliberately so — see `access` below.
 */
export const assetKind = z.enum([
  "image",
  "video",
  "document",
  "link",
  "quote",
  "stat",
  "access",
]);
export type AssetKind = z.infer<typeof assetKind>;

/**
 * How to reach a human, held as data so no message ever has to hold it as text.
 *
 * This is the whole reason contact details are an asset kind rather than a paragraph
 * somebody writes into a template: a phone number that lives in copy can be sent by any
 * touch, to anybody, the moment a model decides it would help. A phone number that lives
 * here can only leave through an asset whose tier the campaign has unlocked, and the
 * composer never sees the digits at all.
 */
export const accessDetails = z.object({
  /** Booking page, on a domain we own, so the hit is a signal we can verify against. */
  bookingUrl: z.string().url().optional(),
  repName: z.string().optional(),
  repRole: z.string().optional(),
  repEmail: z.string().email().optional(),
  repPhone: z.string().optional(),
  /** "Weekdays, 10-6 IST" — printed beside the link so nobody calls into silence. */
  availability: z.string().optional(),
  /**
   * When set, the booking is ours: slots come from this connection's Google Calendar
   * free/busy and the meeting is created there. Without it, bookingUrl is somebody else's
   * page and the campaign only learns of a booking if that page reports it.
   */
  calendar: z
    .object({
      connectionId: objectIdString,
      timezone: z.string().default("Asia/Kolkata"),
      startHour: z.number().int().min(0).max(23).default(10),
      endHour: z.number().int().min(1).max(24).default(18),
      durationMin: z.number().int().positive().default(15),
      /** ISO weekdays, 1 = Monday. */
      weekdays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
      lookaheadDays: z.number().int().positive().default(7),
      minLeadHours: z.number().nonnegative().default(3),
    })
    .optional(),
  meetingTitle: z.string().optional(),
  meetingDescription: z.string().optional(),
});

export const assetFile = z.object({
  url: z.string().url(),
  /** A still for a video, a first page for a document. Inboxes will not play video. */
  thumbUrl: z.string().url().optional(),
  mime: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** Seconds, for video and audio. "90s demo" is a different ask from "12 minute demo". */
  durationSec: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/**
 * What this asset earned, kept on the asset itself.
 *
 * Angles have been graded since the beginning and assets have not, so "value_proof works"
 * has always silently averaged the send that carried a demo video with the one that
 * carried nothing. These three counters are what let `what_works` separate them.
 */
export const assetUsage = z.object({
  sent: z.number().int().nonnegative().default(0),
  clicked: z.number().int().nonnegative().default(0),
  /** Sends carrying this asset where the campaign afterwards reached its goal. */
  ledToGoal: z.number().int().nonnegative().default(0),
});

export const asset = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  /** Stable, human-written, and used by Claude to refer to it: "demo_90s", "case_ecomm_1". */
  key: z.string(),
  name: z.string(),
  kind: assetKind,
  tier: assetTier,

  file: assetFile.optional(),
  access: accessDetails.optional(),
  /** The words themselves, for a `quote` or a `stat` — those have no file to point at. */
  text: z.string().optional(),
  attribution: z.string().optional(),

  /**
   * The three fields that make an asset pickable by a model, and the reason this schema is
   * not just a file table.
   *
   * Tags alone were not enough. A menu of `["margin","returns","pricing"]` asks the
   * composer to guess what each file argues and when it lands, and it guesses wrong in the
   * direction of whatever is at the top of the list. A sentence does not need guessing.
   *
   * useWhen    the condition, in the words a person would use. Read like `segment.detect`.
   * proves     the one thing a reader believes afterwards that they did not before.
   * oneLine    how to introduce it, so the copy leading into it is not written blind.
   */
  useWhen: z.string(),
  proves: z.string(),
  oneLine: z.string(),

  /**
   * Claims this asset makes on its own.
   *
   * Folded into the person's `claimsMade` when it is sent, so a later touch cannot spend
   * its best paragraph making an argument a video already made. Without this, the asset is
   * invisible to the no-repeats rule and the sequence starts talking over itself.
   */
  claims: z.array(z.string()).default([]),

  /** Empty means every segment. Named segments must exist in the product config. */
  forSegment: z.array(z.string()).default([]),
  /** Objection keys this answers, matched against `person.objections`. */
  answers: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  language: z.string().default("en"),

  /**
   * Which channels may carry it. A PDF is not a WhatsApp message and a 40MB video is not
   * an email. Checked against the channel's discovered capabilities at render, so an asset
   * allowed here can still be skipped for a channel that turns out not to support it.
   */
  channels: z.array(channelKey).default(["email"]),

  /**
   * Off by default for tier A, which is the point of the tier.
   *
   * A calendar link and a rep's number are the two things this system can give away that
   * cannot be taken back, so they go through Review even on a campaign set to send
   * automatically.
   */
  requiresApproval: z.boolean().default(false),

  /**
   * A case study with last year's numbers in it is worse than no case study. Past this
   * date the asset drops out of every menu rather than being quietly sent forever.
   */
  expiresAt: z.date().optional(),

  /** "human" is uploaded; "claude" is generated on demand against a template asset block. */
  origin: z.enum(["human", "claude"]).default("human"),
  costUsd: z.number().nonnegative().default(0),

  usage: assetUsage.default({}),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  createdBy: objectIdString.optional(),
  createdAt: z.date(),
});
export type Asset = z.infer<typeof asset>;
