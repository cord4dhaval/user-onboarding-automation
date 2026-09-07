import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { RenderableAsset } from "./compose.js";

/**
 * Which assets a session may offer this person, right now.
 *
 * The menu is computed here rather than searched by the model, and that is the whole
 * point. A composer that can name any asset will eventually name one that does not exist,
 * or one that expired, or the calendar link to somebody who has never opened a message.
 * Every one of those is a rule the engine can apply and a prompt cannot enforce, so the
 * model is handed a short list it is allowed to choose from and nothing else.
 */

/** Cheapest to most expensive, measured in what it costs the reader. See schemas/asset.ts. */
const TIER_RANK: Record<string, number> = { D: 0, C: 1, B: 2, A: 3 };

export interface AssetMenuRow {
  asset_id: string;
  key: string;
  name: string;
  kind: string;
  tier: string;
  /** The three sentences a model actually chooses on. */
  use_when: string;
  proves: string;
  one_line: string;
  claims: string[];
  answers: string[];
  /** True when one of `answers` matches something this person has already objected to. */
  answers_an_objection: boolean;
  /**
   * Smoothed conversion, not a raw rate. `(ledToGoal + 1) / (sent + 2)` puts an asset
   * nobody has tried at 0.5 — above anything that has demonstrably failed and below
   * anything that has demonstrably worked. A raw rate would rank every new asset at zero
   * and it would never get the sends that would prove it, which is the same trap the
   * exploration floor in plan_goal exists to avoid.
   */
  score: number;
  sent: number;
  led_to_goal: number;
}

/**
 * Whether this person has earned the tier-A things: a calendar link, a phone number, a
 * named human.
 *
 * Deliberately not the tier cap. `cadenceByTemp[band].maxAssetTier` governs how much
 * attention a message may ask for, which is a question about content weight; this governs
 * whether we hand over a way to reach us, which is a question about trust and is not
 * recoverable once answered. Someone who has never opened anything does not get a calendar
 * link because the campaign happened to permit heavy assets.
 */
export function accessUnlocked(band?: string): boolean {
  return band === "hot";
}

export interface MenuInput {
  /** From `person.belief.segment`. Assets naming no segment are offered to everyone. */
  segment?: string;
  band?: string;
  /** From `goal.cadenceByTemp[band].maxAssetTier`. Absent means no cap. */
  maxTier?: string;
  /** From `goal.allowedChannels` — an asset no allowed channel can carry is not a choice. */
  channels?: string[];
  /** `person.objections[].text`, so what they pushed back on ranks the answer up. */
  objections?: string[];
  /** Every asset already sent to this person. Nothing is offered twice. */
  sentAssetIds?: string[];
  limit?: number;
  now?: Date;
}

/** Assets already spent on one person, read off the actions rather than a second counter. */
export function assetIdsSentTo(actions: Document[]): string[] {
  const seen = new Set<string>();
  for (const action of actions) {
    // Queued and held messages count. An asset promised in a message waiting in Review is
    // spent as far as the next touch is concerned — offering it again writes two messages
    // carrying the same video, and the second one is written before the first has sent.
    if (action.status === "skipped") continue;
    for (const id of (action.assetIds ?? []) as unknown[]) seen.add(String(id));
  }
  return [...seen];
}

/**
 * Every asset this person may be shown, ranked. `assetMenuFor` is this list cut to a
 * shortlist for a session to read; the refusals below are checked against the whole of it,
 * because an asset being too far down to print is not a reason a choice is wrong.
 */
export async function eligibleAssets(
  orgId: string,
  productId: string,
  input: MenuInput = {},
): Promise<AssetMenuRow[]> {
  const db = await getDb();
  const now = input.now ?? new Date();

  const cap = input.maxTier ? TIER_RANK[input.maxTier] : undefined;
  const tiers = Object.keys(TIER_RANK).filter((t) => cap === undefined || (TIER_RANK[t] ?? 0) <= cap);

  const rows = await db
    .collection(C.assets)
    .find({
      orgId,
      productId,
      status: "active",
      // A case study with last year's numbers is worse than no case study.
      $and: [
        { $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] },
        // An empty list means "every segment", which is not the same as matching none.
        input.segment
          ? { $or: [{ forSegment: { $size: 0 } }, { forSegment: input.segment }] }
          : {},
        input.channels?.length ? { $or: [{ channels: { $size: 0 } }, { channels: { $in: input.channels } }] } : {},
      ],
      tier: { $in: tiers },
    })
    .toArray();

  const spent = new Set(input.sentAssetIds ?? []);
  const unlocked = accessUnlocked(input.band);
  const objections = (input.objections ?? []).map((o) => o.toLowerCase());

  const menu = rows
    .filter((row) => !spent.has(String(row._id)))
    // Access is gated on the person, not on the campaign's tier ceiling. Everything else
    // has already been filtered by tier above.
    .filter((row) => row.kind !== "access" || unlocked)
    .map((row) => {
      const usage = (row.usage ?? {}) as { sent?: number; clicked?: number; ledToGoal?: number };
      const sent = Number(usage.sent ?? 0);
      const led = Number(usage.ledToGoal ?? 0);
      const answers = ((row.answers ?? []) as unknown[]).map(String);
      const hit = answers.some((a) => objections.some((o) => o.includes(a.toLowerCase())));

      return {
        asset_id: String(row._id),
        key: String(row.key),
        name: String(row.name),
        kind: String(row.kind),
        tier: String(row.tier),
        use_when: String(row.useWhen ?? ""),
        proves: String(row.proves ?? ""),
        one_line: String(row.oneLine ?? ""),
        claims: ((row.claims ?? []) as unknown[]).map(String),
        answers,
        answers_an_objection: hit,
        score: (led + 1) / (sent + 2),
        sent,
        led_to_goal: led,
      };
    })
    // An asset that answers something they actually said outranks one that merely performs
    // well across everybody, because the second is an average and the first is about them.
    .sort((a, b) => Number(b.answers_an_objection) - Number(a.answers_an_objection) || b.score - a.score);

  return menu;
}

export async function assetMenuFor(
  orgId: string,
  productId: string,
  input: MenuInput = {},
): Promise<AssetMenuRow[]> {
  const menu = await eligibleAssets(orgId, productId, input);
  return menu.slice(0, input.limit ?? 8);
}

/**
 * The filters that apply to one person, read off documents a caller already has.
 *
 * Pure, so `lead_card` — which has the person and their actions in hand — does not pay for
 * two more queries to describe the person it just loaded.
 */
export function assetContextFrom(
  person: Document | null,
  actions: Document[],
  goalDef: Document | null,
): MenuInput {
  const band = (person?.temp as { band?: string } | undefined)?.band;
  const cadence = (goalDef?.cadenceByTemp ?? {}) as Record<string, { maxAssetTier?: string }>;
  return {
    segment: (person?.belief as { segment?: string } | undefined)?.segment,
    band,
    maxTier: band ? cadence[band]?.maxAssetTier : undefined,
    channels: (goalDef?.allowedChannels ?? []) as string[],
    objections: ((person?.objections ?? []) as Array<{ text?: unknown }>).map((o) => String(o.text ?? "")),
    sentAssetIds: assetIdsSentTo(actions),
  };
}

/** The same context, for a caller that holds only ids. */
export async function assetContextFor(
  orgId: string,
  productId: string,
  personId: string,
  goalDef: Document | null,
): Promise<MenuInput> {
  const db = await getDb();
  const [person, actions] = await Promise.all([
    db.collection(C.people).findOne({ _id: new ObjectId(personId), orgId, productId }),
    db.collection(C.actions).find({ orgId, productId, personId }).project({ assetIds: 1, status: 1 }).toArray(),
  ]);
  return assetContextFrom(person, actions, goalDef);
}

export async function loadAssets(orgId: string, productId: string, ids: string[]): Promise<Document[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const valid = ids.filter((id) => ObjectId.isValid(id));
  return db
    .collection(C.assets)
    .find({ orgId, productId, _id: { $in: valid.map((id) => new ObjectId(id)) } })
    .toArray();
}

/**
 * Why each of these assets may not be sent to this person, in the words the model needs to
 * fix it.
 *
 * Stated per asset and per reason rather than as one refusal, because "not allowed" makes
 * a session guess, and a session that guesses picks the next row down and is refused
 * again. An expired case study and a calendar link to a cold lead are different mistakes
 * and only one of them is about the person.
 */
export async function assetRefusals(
  orgId: string,
  productId: string,
  context: MenuInput,
  ids: string[],
  channel?: string,
): Promise<string[]> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return [];

  const found = await loadAssets(orgId, productId, wanted);
  const byId = new Map(found.map((row) => [String(row._id), row]));
  const now = new Date();
  const spent = new Set(context.sentAssetIds ?? []);
  const cap = context.maxTier ? TIER_RANK[context.maxTier] : undefined;
  const problems: string[] = [];

  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) {
      problems.push(`${id} is not an asset on this product. lead_card lists the ones that are.`);
      continue;
    }
    const label = `${String(row.key)} (${id})`;

    if (row.status !== "active") {
      problems.push(`${label} is ${String(row.status)}, so it is not ready to be sent to anyone.`);
    }
    if (row.expiresAt && new Date(String(row.expiresAt)) <= now) {
      problems.push(`${label} expired — what it claims is no longer true enough to send.`);
    }

    const forSegment = ((row.forSegment ?? []) as unknown[]).map(String);
    if (forSegment.length > 0 && context.segment && !forSegment.includes(context.segment)) {
      problems.push(`${label} is written for ${forSegment.join(", ")}, and this person is ${context.segment}.`);
    }

    const rank = TIER_RANK[String(row.tier)] ?? 0;
    if (cap !== undefined && rank > cap) {
      problems.push(
        `${label} is tier ${String(row.tier)} and this person is ${context.band ?? "unscored"}, ` +
          `which allows up to ${context.maxTier}. Asking for more attention than they have given is how a sequence loses one.`,
      );
    }

    if (row.kind === "access" && !accessUnlocked(context.band)) {
      problems.push(
        `${label} hands over a way to reach us, and this person is ${context.band ?? "unscored"}, not hot. ` +
          `That is offered once they have answered something, not before.`,
      );
    }

    const carriers = ((row.channels ?? []) as unknown[]).map(String);
    if (channel && carriers.length > 0 && !carriers.includes(channel)) {
      problems.push(`${label} can be carried by ${carriers.join(", ")}, and this step sends on ${channel}.`);
    }

    if (spent.has(id)) {
      problems.push(`${label} has already gone to this person. Sending it twice reads as nobody keeping track.`);
    }
  }

  return problems;
}

/**
 * Whether anything this message carries has to be looked at by a person first.
 *
 * Separate from the campaign's approval mode and stronger than it. A campaign set to send
 * automatically is a decision about routine copy; an asset marked for review is a decision
 * about one particular thing — a calendar link, a rep's number — and the narrower decision
 * wins. Otherwise turning on auto-send would quietly turn off every asset-level hold in
 * the product.
 */
export async function assetsNeedApproval(
  orgId: string,
  productId: string,
  assetIds: unknown,
): Promise<boolean> {
  const ids = ((assetIds ?? []) as unknown[]).map(String).filter(Boolean);
  if (ids.length === 0) return false;
  const rows = await loadAssets(orgId, productId, ids);
  return rows.some((row) => row.requiresApproval === true);
}

/**
 * The assets an action carries, flattened to what the renderer needs, in the order the
 * action named them.
 *
 * An asset that has since been deleted or archived simply does not appear. A message must
 * never fail to send because a picture went missing — the words were the message.
 */
export async function renderableAssets(
  orgId: string,
  productId: string,
  assetIds: unknown,
): Promise<RenderableAsset[]> {
  const ids = ((assetIds ?? []) as unknown[]).map(String).filter(Boolean);
  if (ids.length === 0) return [];

  const rows = await loadAssets(orgId, productId, ids);
  const byId = new Map(rows.map((row) => [String(row._id), row]));

  return ids
    .map((id) => byId.get(id))
    .filter((row): row is Document => Boolean(row) && row!.status !== "archived")
    .map((row) => {
      const file = (row.file ?? {}) as { url?: string; thumbUrl?: string };
      return {
        key: String(row.key),
        tier: String(row.tier),
        kind: String(row.kind),
        oneLine: String(row.oneLine ?? ""),
        url: file.url,
        thumbUrl: file.thumbUrl,
        text: row.text ? String(row.text) : undefined,
        attribution: row.attribution ? String(row.attribution) : undefined,
        access: (row.access ?? undefined) as RenderableAsset["access"],
      };
    });
}

/**
 * What an asset earned, counted where it happened.
 *
 * Three moments, three counters: a message carrying it went out, a person clicked
 * something in that message, and a campaign that had shown it reached its goal. The ratio
 * of the third to the first is what orders every menu after this, so each one is written
 * exactly once — sends on dispatch, clicks behind the first-click filter that already
 * exists, and wins behind the stamp that already refuses to credit a campaign twice.
 *
 * Never fatal. A counter is bookkeeping, and a message that has already gone out must not
 * be reported as failed because a statistic could not be written.
 */
export async function creditAssets(
  orgId: string,
  productId: string,
  assetIds: unknown,
  field: "sent" | "clicked" | "ledToGoal",
): Promise<void> {
  const ids = ((assetIds ?? []) as unknown[]).map(String).filter((id) => ObjectId.isValid(id));
  if (ids.length === 0) return;
  try {
    const db = await getDb();
    await db
      .collection(C.assets)
      .updateMany(
        { orgId, productId, _id: { $in: ids.map((id) => new ObjectId(id)) } },
        { $inc: { [`usage.${field}`]: 1 } },
      );
  } catch {
    // Deliberately silent. See above.
  }
}

/** The most expensive tier in a set — what a message as a whole asked of its reader. */
export function highestTier(tiers: string[]): string | null {
  let best: string | null = null;
  for (const tier of tiers) {
    if (TIER_RANK[tier] === undefined) continue;
    if (best === null || (TIER_RANK[tier] ?? 0) > (TIER_RANK[best] ?? 0)) best = tier;
  }
  return best;
}

/**
 * The one access asset this person has earned, or nothing.
 *
 * Runs the same filters as the menu and then takes the best-performing row, because this
 * is not a choice a session gets to make. It fires on a temperature change, minutes after
 * a click, and waiting for a Claude session to pick between two calendars would spend the
 * moment the message exists to catch.
 */
export async function accessAssetFor(
  orgId: string,
  productId: string,
  context: MenuInput,
): Promise<AssetMenuRow | null> {
  if (!accessUnlocked(context.band)) return null;
  const eligible = await eligibleAssets(orgId, productId, context);
  return eligible.find((row) => row.kind === "access") ?? null;
}
