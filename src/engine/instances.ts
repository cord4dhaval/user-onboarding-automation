import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * Which of a lead's campaigns something belongs to.
 *
 * A lead can be in several campaigns at once — one per campaign, never two of the same —
 * so "the lead's campaign" is a choice wherever a signal arrives without saying which
 * campaign caused it: a reply, a site visit, a classification, a nudge. The choice is made
 * here, once, the same way everywhere:
 *
 *   1. a campaign that uses the channel the signal came in on, when that is known;
 *   2. a campaign Claude is planning for (it has a plan), over one that only sent a
 *      fixed first message;
 *   3. the one that wrote to them most recently;
 *   4. the one that started most recently.
 *
 * Where the signal does name its campaign — a click on a tracked link, a reply to a known
 * message — that campaign is used and none of this runs.
 */
export function rankInstances(
  open: Document[],
  opts: { channel?: string; goalsByKey?: Map<string, Document> } = {},
): Document[] {
  const usesChannel = (instance: Document): number => {
    if (!opts.channel || !opts.goalsByKey) return 0;
    const allowed = (opts.goalsByKey.get(String(instance.goalKey))?.allowedChannels ?? ["email"]) as string[];
    return allowed.includes(opts.channel) ? 1 : 0;
  };
  const time = (value: unknown): number => (value ? new Date(value as string | Date).getTime() || 0 : 0);

  return [...open].sort(
    (a, b) =>
      usesChannel(b) - usesChannel(a) ||
      Number(Boolean(b.currentPlanId)) - Number(Boolean(a.currentPlanId)) ||
      time(b.lastContactedAt) - time(a.lastContactedAt) ||
      time(b.startedAt) - time(a.startedAt),
  );
}

/** The lead's campaign for a signal that did not name one. Null when none is open. */
export async function activeInstanceFor(args: {
  orgId: string;
  productId: string;
  personId: string;
  channel?: string;
}): Promise<Document | null> {
  const db = await getDb();
  const open = await db
    .collection(C.goalInstances)
    .find({ orgId: args.orgId, productId: args.productId, personId: args.personId, status: "active" })
    .toArray();
  if (open.length <= 1) return open[0] ?? null;

  const goalsByKey = args.channel
    ? new Map(
        (
          await db
            .collection(C.goals)
            .find({ orgId: args.orgId, productId: args.productId, key: { $in: open.map((i) => String(i.goalKey)) } })
            .project({ key: 1, allowedChannels: 1 })
            .toArray()
        ).map((g) => [String(g.key), g]),
      )
    : undefined;
  return rankInstances(open, { channel: args.channel, goalsByKey })[0] ?? null;
}

/**
 * The campaign a reply answers: the one whose message went out to them last, while it is
 * still open. A reply is to a message, and the message knows its campaign.
 */
export async function instanceOfLastSend(args: {
  orgId: string;
  productId: string;
  personId: string;
}): Promise<Document | null> {
  const db = await getDb();
  const lastSend = await db
    .collection(C.actions)
    .find({ orgId: args.orgId, productId: args.productId, personId: args.personId, status: { $in: ["sent", "dispatched"] } })
    .sort({ sentAt: -1 })
    .limit(1)
    .next();
  if (lastSend?.goalInstanceId) {
    const instance = await db
      .collection(C.goalInstances)
      .findOne({ _id: new ObjectId(String(lastSend.goalInstanceId)), status: "active" });
    if (instance) return instance;
  }
  return activeInstanceFor({ ...args, channel: lastSend?.channel ? String(lastSend.channel) : undefined });
}

/** One campaign per person out of a list of open ones, chosen as above. */
export function primaryByPerson(open: Document[]): Map<string, Document> {
  const byPerson = new Map<string, Document[]>();
  for (const instance of open) {
    const key = String(instance.personId);
    byPerson.set(key, [...(byPerson.get(key) ?? []), instance]);
  }
  return new Map([...byPerson].map(([personId, list]) => [personId, rankInstances(list)[0]!]));
}
