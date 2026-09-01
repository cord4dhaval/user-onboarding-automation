import { z } from "zod";
import { objectIdString } from "./common.js";

/**
 * A source is a fetch job sitting on a connection. Auth is shared via the connection so
 * two goals reading the same endpoint cannot each keep their own cursor and double-process.
 */
export const source = z.object({
  orgId: objectIdString,
  productId: objectIdString,
  connectionId: objectIdString,
  name: z.string(),
  kind: z.enum(["excel_upload", "csv", "api_pull", "webhook_push", "mcp_source", "crm_sync", "audience"]),
  /** Set when kind is "audience" — the group in the library this campaign draws from. */
  audienceId: objectIdString.optional(),

  /**
   * realtime: the person just raised their hand, so the first touch ignores quiet hours.
   * batch: a bulk import, so the first touch waits for a civil hour in their timezone.
   */
  triggerMode: z.enum(["realtime", "batch"]),

  /** Desired interval from the goal; effective interval after platform floors are applied. */
  desiredIntervalSec: z.number().int().positive().optional(),
  effectiveIntervalSec: z.number().int().positive().optional(),
  nextFetchAt: z.date().optional(),

  /** Generated once by Claude from the source's own field names, then reused. */
  fieldMap: z.record(z.string(), z.string()),
  dedupeKey: z.string().default("email"),
  cursor: z.string().optional(),

  defaultGoalKey: z.string(),
  enabled: z.boolean().default(true),
  lastRunAt: z.date().optional(),
  health: z.object({ status: z.string(), error: z.string().optional() }).optional(),
});
export type Source = z.infer<typeof source>;
