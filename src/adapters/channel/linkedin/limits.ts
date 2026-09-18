/**
 * What a LinkedIn account may do, written onto its channel when it is connected. The numbers
 * are the channel's rules (src/channels/rules.ts), with the product's overrides, copied onto
 * the channel document so one account can be tuned on its own without a deploy.
 *
 * Profile views have no cap of their own: the send path looks a lead up once and keeps the
 * member id, so views are bounded by the invite cap.
 */

import { rulesFor } from "../../../channels/rules.js";

export function linkedinGovernor(connectedAt: Date, product?: Record<string, unknown> | null) {
  const rules = rulesFor("linkedin", product);
  return {
    // No overall day cap: the per-action caps are the day's limit, and one number across
    // invites and messages would be too tight for one or too loose for the other.
    dailyCap: 0,
    perMinute: rules.perMinute,
    perHour: rules.perHour,
    perOp: rules.perOp,
    spacing: rules.spacing,
    warmupStartedAt: connectedAt,
    warmupDay: 1,
    sentToday: 0,
    windowStartedAt: connectedAt,
  };
}

/**
 * The lengths the validator holds a LinkedIn send to. A free account can add a note to only
 * three invites a month, so it sends invites without one (`inviteNote: "none"`); a Premium
 * account writes a note on every invite.
 */
export function linkedinCapabilities(premium: boolean, product?: Record<string, unknown> | null) {
  const rules = rulesFor("linkedin", product);
  return {
    maxBodyLength: rules.maxLength?.message,
    maxNoteLength: rules.maxLength?.note,
    inviteNote: premium ? ("note" as const) : ("none" as const),
  };
}
