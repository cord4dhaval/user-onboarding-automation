import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Spreading the hooks across a campaign.
 *
 * An idea is the moment a mail describes; a hook is the job it does — the money nobody counts, the
 * habit that eats the day, the thing found out too late. Ideas have been capped since 2026-09-22,
 * hooks never were, and it showed: of about 250 hooked sends on teamgrid_leads_v3, 57 were
 * hidden_bill and 44 found_out_late, so a quarter of the campaign made the same argument with
 * different scenes. A hook that lands on a quarter of the list also learns nothing, because its
 * record cannot be compared with hooks nobody used.
 *
 * The first attempt copied ideas.ts — leads per hook per week, with a cap that grows with the
 * campaign — and the live numbers showed why that is the wrong shape here. There are 7 hooks and
 * 71 usable ideas, and a rolling plan re-plans the same lead every few days, so within a week
 * every hook legitimately reaches almost every lead: 28 to 36 leads each against a cap of 16. It
 * would have refused nearly every step and spent the run on refusals.
 *
 * What is actually lopsided is the sends. So the measure is each hook's share of the campaign's
 * recent sends, against the share it would have if the seven were even. A hook over that share by
 * half again is spent until it falls back — which cannot refuse everything, because shares sum to
 * one and some hook is always under.
 */

/** Sends read back per campaign: enough to see a pattern, recent enough that old skew fades. */
export const HOOK_WINDOW = 120;
/** Below this many sends there is no pattern to correct, so nothing is refused. */
export const HOOK_MIN_SENDS = 20;
/** How far past an even share a hook may go: half again. */
export const HOOK_SHARE_TOLERANCE = 1.5;

export interface HookShare {
  hook: string;
  sends: number;
  share: number;
  /** The share this hook may reach before it waits: (tolerance / hooks). */
  allowed: number;
  spent: boolean;
}

export interface HookSpread {
  total: number;
  rows: HookShare[];
  /** Hooks at or over their allowed share. Empty until HOOK_MIN_SENDS sends are in. */
  spent: string[];
  /** Hooks under an even share: the ones to pick from first. */
  open: string[];
}

/**
 * Each hook's share of a campaign's recent sends, and whether it has had more than its share.
 *
 * Only the hooks the lead type offers are measured. A word a writer invented for one mail is not a
 * slot other leads are queuing for, and counting it would shrink everyone else's share.
 */
export async function hookSpread(input: { orgId: string; productId: string; goalKey: string; hooks: string[] }): Promise<HookSpread> {
  const db = await getDb();
  const instances = await db
    .collection(C.goalInstances)
    .find({ orgId: input.orgId, productId: input.productId, goalKey: input.goalKey }, { projection: { _id: 1 } })
    .toArray();
  const ids = instances.map((i) => String(i._id));
  const known = new Set(input.hooks.map((h) => h.toLowerCase()));
  const sends = ids.length
    ? await db
        .collection(C.actions)
        .find(
          { orgId: input.orgId, goalInstanceId: { $in: ids }, status: { $in: ["sent", "dispatched"] }, dryRun: { $ne: true }, hook: { $exists: true } },
          { projection: { hook: 1, sentAt: 1 } },
        )
        .sort({ sentAt: -1 })
        .limit(HOOK_WINDOW)
        .toArray()
    : [];
  const counted = sends.map((a) => String(a.hook ?? "").trim().toLowerCase()).filter((hook) => known.has(hook));
  const total = counted.length;
  const per = new Map<string, number>();
  for (const hook of counted) per.set(hook, (per.get(hook) ?? 0) + 1);

  const even = input.hooks.length > 0 ? 1 / input.hooks.length : 0;
  const allowed = even * HOOK_SHARE_TOLERANCE;
  const rows: HookShare[] = input.hooks.map((hook) => {
    const count = per.get(hook.toLowerCase()) ?? 0;
    const share = total > 0 ? count / total : 0;
    return { hook, sends: count, share: Number(share.toFixed(3)), allowed: Number(allowed.toFixed(3)), spent: total >= HOOK_MIN_SENDS && share >= allowed };
  });
  return {
    total,
    rows,
    spent: rows.filter((r) => r.spent).map((r) => r.hook),
    open: rows.filter((r) => !r.spent && r.share < even).map((r) => r.hook),
  };
}
