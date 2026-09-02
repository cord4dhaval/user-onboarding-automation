import { ist } from "../../../ui/time";

/**
 * How a send window is described on screen. Shared by the channels list, which renders on
 * the server, and the settings drawer, which renders on the client — so it cannot live in
 * either one's module.
 */

export interface UsageWindow {
  label: string;
  used: number;
  limit: number;
  /** How many more may go out right now. */
  free: number;
  /** ISO — when the oldest send in this window ages out and frees one slot. */
  freesAt?: string;
}

/**
 * "daily" is the engine's word for a window 24 hours wide. On a screen it reads as
 * "today", which is what made a count dropping from 50 to 47 with nobody sending anything
 * look like a bug rather than three slots coming back.
 */
export const WINDOW_LABEL: Record<string, string> = {
  "per-minute": "per minute",
  hourly: "per hour",
  daily: "per 24h",
};

/**
 * Window boundaries are computed in UTC and shown in IST, like every other time in the
 * console. See `app/ui/time.ts` for why the zone is pinned rather than read off the host.
 */
export function windowTime(iso: string): string {
  return `${ist(iso)} IST`;
}
