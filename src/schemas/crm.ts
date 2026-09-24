import { z } from "zod";

/**
 * What a CRM can tell us about a person, read-only.
 *
 * A sales team working the same leads in their own CRM is half of the person's story: the
 * call that went unanswered, the demo booked for Monday, the deal marked lost with a
 * reason. None of it reaches us on its own, so a campaign kept mailing a man whose demo
 * was booked for that afternoon.
 *
 * Nothing here is specific to one CRM. The map names which tool answers which question and
 * where in its answer each field sits, the same way a binding does for sending. A CRM with
 * different tool names needs a different map, not different code.
 */

/**
 * What an event in the CRM means to us, whatever the CRM called it. `field` and `info` are
 * shown quietly; every other kind is something a person on the sales team did or saw.
 */
export const crmKind = z.enum([
  "created",
  "owner",
  "stage",
  "status",
  "won",
  "lost",
  "reopened",
  "note",
  "call",
  "call_missed",
  "meeting_booked",
  "meeting_canceled",
  "meeting_held",
  "email_in",
  "email_out",
  "followup",
  "deleted",
  "field",
  "info",
]);
export type CrmKind = z.infer<typeof crmKind>;

/**
 * One tool call that returns a list.
 *
 * `args` values are literals or `$refs` resolved at call time: `$email`, `$phone`,
 * `$recordId`, `$from`. `items` and `next` are paths into the answer; `cursorArg` is the
 * argument the next page's cursor goes back in as.
 */
export const crmListCall = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  items: z.string().default("data"),
  next: z.string().optional(),
  cursorArg: z.string().optional(),
});
export type CrmListCall = z.infer<typeof crmListCall>;

export const crmRecordCall = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Where the record sits in the answer. Absent means the answer is the record. */
  path: z.string().optional(),
});

export const crmMap = z.object({
  /** Merged into every call: the tenant to read, when one token can see several. */
  scope: z.record(z.string(), z.unknown()).default({}),
  /**
   * The CRM's own projects or pipelines that belong to this product. One CRM often holds
   * several products' deals, and a deal won for another product is not this product's
   * customer. Empty means every record belongs.
   */
  projects: z.array(z.string()).default([]),

  findByEmail: crmListCall,
  findByPhone: crmListCall.optional(),
  /** The full record. Without it, the row the find call returned is all we keep. */
  record: crmRecordCall.optional(),
  /** Everything that happened on one record, `$recordId`. */
  events: crmListCall,
  /** Everything that happened anywhere since `$from`, for the incremental poll. */
  changes: crmListCall,
  /** Full note text. Timelines tend to cut notes short; a note is the words a rep wrote. */
  notes: crmListCall.optional(),
  meetings: crmListCall.optional(),

  /** Paths inside a record. Only `id` is required; a missing path is a field we do not keep. */
  fields: z.object({
    id: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    status: z.string().optional(),
    stage: z.string().optional(),
    owner: z.string().optional(),
    source: z.string().optional(),
    value: z.string().optional(),
    currency: z.string().optional(),
    project: z.string().optional(),
    followUp: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    wonAt: z.string().optional(),
    lostAt: z.string().optional(),
    lostReason: z.string().optional(),
    deleted: z.string().optional(),
  }),
  eventFields: z.object({
    at: z.string(),
    type: z.string(),
    recordId: z.string(),
    text: z.string().optional(),
    actor: z.string().optional(),
    id: z.string().optional(),
  }),
  noteFields: z
    .object({ at: z.string(), text: z.string(), actor: z.string().optional(), id: z.string().optional() })
    .optional(),
  meetingFields: z
    .object({
      title: z.string(),
      start: z.string(),
      end: z.string().optional(),
      status: z.string().optional(),
      organizer: z.string().optional(),
      summary: z.string().optional(),
      actionItems: z.string().optional(),
      nextSteps: z.string().optional(),
    })
    .optional(),

  /** Overrides for event types the name alone reads wrongly. Anything else is inferred. */
  eventKinds: z.record(z.string(), crmKind).default({}),
  /**
   * Event types that only announce a note. With a notes call mapped, the note itself is
   * kept and these are dropped, or every note would appear twice, once cut short.
   */
  noteEventTypes: z.array(z.string()).default([]),
  /** How `$from` is written: a bare day (`2026-09-21`) or a full instant. */
  fromFormat: z.enum(["date", "iso"]).default("date"),
  /**
   * Who we are inside their CRM: the actor names, emails or ids our own writes appear under.
   *
   * Everything we write there comes back through the same read as everything their team
   * writes, and a note about an email we sent, read back, is news that re-plans the next
   * email. Without this the system writes to itself. Filled in by the writer itself the first
   * time it writes, because the CRM's reply says which actor it recorded, and a value nobody
   * has to type is a value nobody can get wrong.
   */
  ours: z.array(z.string()).default([]),
});
export type CrmMap = z.infer<typeof crmMap>;

/** The record as we keep it, so the page and the planner never need the CRM to answer. */
export interface CrmSnapshot {
  name?: string;
  email?: string;
  phone?: string;
  status?: string;
  stage?: string;
  owner?: string;
  source?: string;
  value?: number;
  currency?: string;
  project?: string;
  followUp?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  wonAt?: Date;
  lostAt?: Date;
  lostReason?: string;
  deleted?: boolean;
}

export interface CrmMeeting {
  title: string;
  start?: Date;
  end?: Date;
  status?: string;
  organizer?: string;
  summary?: string;
  actionItems?: string[];
  nextSteps?: string;
}

/**
 * linked      this record is this person
 * review      probably this person, but something disagrees; shown, never acted on
 * unmatched   nobody of ours; kept so the poll does not ask about it again
 * out_of_scope  belongs to another product's project in the same CRM
 */
export type CrmLinkStatus = "linked" | "review" | "unmatched" | "out_of_scope";
export type CrmMatchedBy = "email+phone" | "email" | "phone" | "manual";
