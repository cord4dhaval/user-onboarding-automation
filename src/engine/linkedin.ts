import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";
import { LinkedInClient, memberIdOf } from "../adapters/channel/linkedin/client.js";
import { SessionError, type LinkedInSession } from "../adapters/channel/linkedin/session.js";
import { rulesFor, type ChannelRules } from "../channels/rules.js";
import { takeChannelDown } from "./channelHealth.js";
import { notify } from "./notify.js";
import { mailOwner } from "./ownerMail.js";
import { looksLikeOptOut } from "./inbound.js";
import { unsubscribePerson } from "./unsubscribe.js";
import { PRIORITY, enqueueMany } from "./queue.js";
import { pauseForReply } from "./campaignRules.js";

/**
 * What LinkedIn will not push to us, read on a clock: who accepted an invite, whose invite
 * has waited too long, and whether the account's invites are being accepted often enough
 * to keep sending them. Runs from the tick for every LinkedIn channel, each account on its
 * own random cadence, so the checks look like a person opening the site, not a timer.
 *
 * Reading new messages belongs here too. It waits on the messaging query ids being copied
 * from a live session (endpoints.ts); `recordLinkedInReply` below is what each new message
 * will go through once they are.
 */

/** The reason a message waits for an accept. The accept check brings these forward. */
export const WAITING_FOR_ACCEPT = "waiting for the connection to be accepted";

export interface LinkedInPollSummary {
  accounts: number;
  checked: number;
  accepted: number;
  expired: number;
  invitesPaused: number;
  errors: string[];
}

export async function pollLinkedIn(orgId: string, productId: string, now = new Date()): Promise<LinkedInPollSummary> {
  const db = await getDb();
  const summary: LinkedInPollSummary = { accounts: 0, checked: 0, accepted: 0, expired: 0, invitesPaused: 0, errors: [] };

  const channels = await db
    .collection(C.channels)
    .find({ orgId, productId, key: "linkedin", status: "healthy", enabled: { $ne: false } })
    .toArray();
  if (channels.length === 0) return summary;
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) });
  const rules = rulesFor("linkedin", product);

  for (const channel of channels) {
    summary.accounts++;
    const next = (channel.linkedinPoll as { nextAcceptsAt?: Date } | undefined)?.nextAcceptsAt;
    if (next && new Date(next) > now) continue;
    summary.checked++;

    try {
      summary.accepted += await recordAccepts(orgId, productId, channel, await clientFor(orgId, channel), now);
    } catch (err) {
      // A dead session found by a read is the same fault as one found by a send.
      if (err instanceof SessionError) {
        await takeChannelDown(orgId, String(channel._id), err.message, err.kind !== "restricted");
      }
      summary.errors.push(`${String(channel.from ?? channel._id)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    summary.expired += await expireInvites(orgId, productId, channel, rules, now);
    if (await guardAcceptRate(orgId, productId, channel, rules, now)) summary.invitesPaused++;

    const [minH, maxH] = rules.pollEvery?.acceptsHours ?? [3, 5];
    const hours = minH + Math.random() * Math.max(0, maxH - minH);
    await db.collection(C.channels).updateOne(
      { _id: channel._id },
      { $set: { "linkedinPoll.lastAcceptsAt": now, "linkedinPoll.nextAcceptsAt": new Date(now.getTime() + hours * 3_600_000) } },
    );
  }
  return summary;
}

async function clientFor(orgId: string, channel: Document): Promise<LinkedInClient> {
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(String(channel.connectionId)) });
  const session = JSON.parse(await resolveSecret(orgId, String(channel.connectionId), "engine.linkedin.poll")) as LinkedInSession;
  return new LinkedInClient(session, (connection?.linkedin as { providerId?: string } | undefined)?.providerId);
}

/** The latest invite this channel sent each of these people, by person id. */
async function latestInvites(orgId: string, channelId: string, filter: Document): Promise<Map<string, Document>> {
  const db = await getDb();
  const rows = await db
    .collection(C.actions)
    .find({ orgId, channelId, channel: "linkedin", op: "invite", status: "sent", ...filter })
    .sort({ sentAt: -1 })
    .project({ personId: 1, sentAt: 1 })
    .toArray();
  const out = new Map<string, Document>();
  for (const row of rows) if (!out.has(String(row.personId))) out.set(String(row.personId), row);
  return out;
}

/**
 * Invited leads who now appear among the account's newest connections. Each one gets the
 * time they connected on their record and an accept on their history, and any message that
 * was waiting for the accept is brought forward to now.
 */
export async function recordAccepts(
  orgId: string,
  productId: string,
  channel: Document,
  client: Pick<LinkedInClient, "recentConnections">,
  now: Date,
): Promise<number> {
  const db = await getDb();
  const invites = await latestInvites(orgId, String(channel._id), { sentAt: { $gte: new Date(now.getTime() - 60 * 86_400_000) } });
  if (invites.size === 0) return 0;

  const waiting = await db
    .collection(C.people)
    .find({
      _id: { $in: [...invites.keys()].map((id) => new ObjectId(id)) },
      "linkedin.providerId": { $exists: true },
      "linkedin.connectedAt": { $exists: false },
    })
    .project({ linkedin: 1 })
    .toArray();
  if (waiting.length === 0) return 0;

  const connected = new Map((await client.recentConnections(40)).map((c) => [c.memberId, c.connectedAt]));
  let accepted = 0;
  for (const person of waiting) {
    const providerId = String((person.linkedin as { providerId?: string }).providerId);
    const at = connected.get(memberIdOf(providerId));
    if (!at) continue;
    const personId = String(person._id);
    const invite = invites.get(personId)!;

    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { "linkedin.connectedAt": at } });
    await db.collection(C.events).insertOne({
      orgId,
      productId,
      personId,
      type: "linkedin_accepted",
      channel: "linkedin",
      actionId: String(invite._id),
      ts: at,
      handled: true,
      payload: {},
    });
    await db.collection(C.actions).updateMany(
      { orgId, productId, personId, channel: "linkedin", status: "queued", deferReason: WAITING_FOR_ACCEPT },
      { $set: { dueAt: now }, $unset: { deferReason: "" } },
    );
    accepted++;
  }
  return accepted;
}

/**
 * An invite nobody accepted in the rule's number of days is given up on: the lead's
 * LinkedIn messages are skipped with that reason, and the lead's record says so. Withdrawing
 * the invite on LinkedIn itself waits on that endpoint being captured from a live session.
 */
async function expireInvites(orgId: string, productId: string, channel: Document, rules: ChannelRules, now: Date): Promise<number> {
  const db = await getDb();
  const days = rules.withdrawAfterDays ?? 21;
  const stale = await latestInvites(orgId, String(channel._id), { sentAt: { $lte: new Date(now.getTime() - days * 86_400_000) } });
  if (stale.size === 0) return 0;

  const people = await db
    .collection(C.people)
    .find({
      _id: { $in: [...stale.keys()].map((id) => new ObjectId(id)) },
      "linkedin.connectedAt": { $exists: false },
      "linkedin.inviteExpiredAt": { $exists: false },
    })
    .project({ _id: 1 })
    .toArray();

  const reason = `the LinkedIn invite was not accepted in ${days} days`;
  for (const person of people) {
    const personId = String(person._id);
    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { "linkedin.inviteExpiredAt": now } });
    await db.collection(C.actions).updateMany(
      { orgId, productId, personId, channel: "linkedin", status: { $in: ["queued", "awaiting_approval"] } },
      { $set: { status: "skipped", skipReason: reason }, $unset: { deferReason: "" } },
    );
    await db.collection(C.events).insertOne({
      orgId,
      productId,
      personId,
      type: "linkedin_invite_expired",
      channel: "linkedin",
      actionId: String(stale.get(personId)!._id),
      ts: now,
      handled: true,
      payload: { days },
    });
  }
  return people.length;
}

/**
 * Stops invites, not messages, when too few are being accepted. A low acceptance rate is
 * what LinkedIn restricts accounts for, and it means the list or the targeting is wrong, which
 * sending more invites cannot fix. Lifts on its own once the rate recovers.
 */
async function guardAcceptRate(orgId: string, productId: string, channel: Document, rules: ChannelRules, now: Date): Promise<boolean> {
  const db = await getDb();
  const guard = rules.acceptRate;
  if (!guard) return false;

  const invites = await db
    .collection(C.actions)
    .find({
      orgId,
      channelId: String(channel._id),
      channel: "linkedin",
      op: "invite",
      status: "sent",
      sentAt: { $lte: new Date(now.getTime() - guard.afterDays * 86_400_000) },
    })
    .sort({ sentAt: -1 })
    .limit(guard.window)
    .project({ personId: 1 })
    .toArray();

  let reason: string | null = null;
  if (invites.length >= guard.minSample) {
    const accepted = await db.collection(C.people).countDocuments({
      _id: { $in: invites.map((i) => new ObjectId(String(i.personId))) },
      "linkedin.connectedAt": { $exists: true },
    });
    const rate = accepted / invites.length;
    if (rate < guard.min) {
      reason =
        `only ${Math.round(rate * 100)}% of the last ${invites.length} invites were accepted, under ` +
        `${Math.round(guard.min * 100)}%; invites are paused to protect the account`;
    }
  }

  const was = (channel.governor as { invitesPausedReason?: string } | undefined)?.invitesPausedReason;
  if (reason) {
    await db.collection(C.channels).updateOne({ _id: channel._id }, { $set: { "governor.invitesPausedReason": reason } });
    if (!was) {
      await notify({
        orgId,
        productId,
        severity: "action",
        dedupeKey: `linkedin:invites-paused:${String(channel._id)}`,
        title: `LinkedIn invites paused on ${String(channel.from ?? "an account")}`,
        body: `${reason[0]!.toUpperCase()}${reason.slice(1)}. Check who the campaign is inviting.`,
        href: `/products/${productId}/channels`,
      });
    }
  } else if (was) {
    await db.collection(C.channels).updateOne({ _id: channel._id }, { $unset: { "governor.invitesPausedReason": "" } });
  }
  return Boolean(reason);
}

/**
 * One message a lead wrote on LinkedIn, recorded the way an email reply is: on their
 * history with its channel and the touch it answers, their other queued messages stopped,
 * the owner told at once, and a request to stop honoured without waiting for anyone.
 *
 * Answering is not queued here. Email replies go to the React routine, which writes email;
 * a LinkedIn answer belongs to the LinkedIn routine (L2), so the owner answers it until then.
 */
export async function recordLinkedInReply(input: {
  orgId: string;
  productId: string;
  personId: string;
  text: string;
  at: Date;
  messageUrn: string;
  conversationUrn?: string;
}): Promise<"recorded" | "duplicate" | "unsubscribed"> {
  const db = await getDb();
  const { orgId, productId, personId, text, at } = input;
  const seen = await db.collection(C.events).findOne({ orgId, type: "reply_received", "payload.messageUrn": input.messageUrn });
  if (seen) return "duplicate";

  const answered = await db
    .collection(C.actions)
    .findOne({ orgId, personId, channel: "linkedin", status: "sent", sentAt: { $lte: at } }, { sort: { sentAt: -1 }, projection: { _id: 1 } });
  const recorded = await db.collection(C.events).insertOne({
    orgId,
    productId,
    personId,
    type: "reply_received",
    channel: "linkedin",
    ...(answered ? { actionId: String(answered._id) } : {}),
    ts: at,
    handled: false,
    payload: { messageUrn: input.messageUrn, conversationUrn: input.conversationUrn, text },
  });

  if (looksLikeOptOut(text)) {
    await unsubscribePerson(personId, "replied on LinkedIn asking to stop");
    return "unsubscribed";
  }

  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId) }, { projection: { name: 1 } });
  await db.collection(C.people).updateOne({ _id: new ObjectId(personId) }, { $set: { lastReplyAt: at } });
  // The campaign they answered pauses until they are answered; their other campaigns run on.
  await pauseForReply({ orgId, productId, answeredActionId: answered ? String(answered._id) : undefined, eventId: recorded.insertedId, at, reason: "they replied on LinkedIn; waiting on a human answer" });
  const who = String(person?.name ?? "A lead");
  await notify({
    orgId,
    productId,
    severity: "action",
    dedupeKey: `engagement:replied:${personId}`,
    title: `${who} replied on LinkedIn`,
    body: text ? `${text.slice(0, 160).replace(/\s+/g, " ").trim()}${text.length > 160 ? "…" : ""}` : undefined,
    href: `/products/${productId}/library/${personId}`,
  });
  await mailOwner(orgId, productId, {
    subject: `LinkedIn reply from ${who}`,
    lines: [`${who} replied on LinkedIn:`, "", text.slice(0, 1200), "", "Answer them on LinkedIn. Their queued messages are on hold."],
    href: `/products/${productId}/library/${personId}`,
  });
  return "recorded";
}

/**
 * Whether Claude plans and writes this campaign's LinkedIn touches (routine 6). Set on the
 * campaign as `linkedin.planner: "claude"`; without it a LinkedIn campaign runs fixed
 * templates through the ordinary playbook, as the first test did.
 */
export function claudePlansLinkedIn(goal: Document | null | undefined): boolean {
  return (goal?.linkedin as { planner?: string } | undefined)?.planner === "claude";
}

// ── what Claude is asked to do (routine 6) ─────────────────────────────────────

export type LinkedInNeed =
  | { kind: "pick" }
  | { kind: "answer"; eventId: string }
  | { kind: "plan"; reason: "accepted" | "no_reply" }
  | { kind: "wait"; why: string }
  | { kind: "end"; why: string };

/**
 * What one lead needs from Claude right now, read from their record and their history. The
 * detector asks with it and the lead card shows it, so the question a session is handed and
 * the answer it reads can never disagree.
 */
export function linkedinNeed(input: {
  instance: Document;
  person: Document;
  /** This campaign's LinkedIn actions for the lead, any status. */
  actions: Document[];
  /** Their LinkedIn replies nobody has answered yet. */
  openReplies: Document[];
  rules: ChannelRules;
  now: Date;
}): LinkedInNeed {
  const { instance, person, actions, openReplies, rules, now } = input;
  const li = (person.linkedin ?? {}) as { connectedAt?: Date; inviteExpiredAt?: Date };
  const mine = (instance.linkedin ?? {}) as { pick?: string };
  const waitingSend = actions.some((a) => ["queued", "awaiting_approval", "sending"].includes(String(a.status)));

  if (openReplies[0]) return { kind: "answer", eventId: String(openReplies[0]._id) };
  if (!mine.pick) {
    return actions.some((a) => a.status === "sent") ? { kind: "wait", why: "invited before Claude picked" } : { kind: "pick" };
  }
  if (mine.pick === "skip") return { kind: "end", why: "Claude chose not to invite them" };
  if (li.inviteExpiredAt && !li.connectedAt) return { kind: "end", why: "the invite was not accepted" };
  if (!li.connectedAt) return { kind: "wait", why: "waiting for the invite to be accepted" };
  if (waitingSend) return { kind: "wait", why: "a message is already on its way" };

  const lastReply = person.lastReplyAt ? new Date(String(person.lastReplyAt)) : null;
  const messages = actions.filter((a) => a.op === "message" && a.status === "sent" && a.angle !== "reply");
  const unanswered = messages.filter((a) => !lastReply || new Date(String(a.sentAt)) > lastReply);

  // A plan queues its messages the moment it is written, so "a message is on its way" above
  // is what stops a lead being asked about twice.
  if (messages.length === 0) return { kind: "plan", reason: "accepted" };
  if (unanswered.length >= (rules.maxUnanswered ?? 3)) return { kind: "end", why: `${unanswered.length} messages with no answer` };

  const lastSent = new Date(Math.max(...messages.map((a) => new Date(String(a.sentAt)).getTime())));
  const watchUntil = new Date(lastSent.getTime() + (rules.watchWindowHours ?? 96) * 3_600_000);
  if (now < watchUntil) return { kind: "wait", why: `giving the last message until ${watchUntil.toISOString()}` };
  return { kind: "plan", reason: "no_reply" };
}

/**
 * Hands routine 6 the leads that need it, one job per lead, a reply first. Leads whose
 * sequence is over are closed here with the reason, so nobody is left open forever.
 */
export async function detectLinkedInWork(orgId: string, productId: string, now = new Date()): Promise<{ asked: number; ended: number }> {
  const db = await getDb();
  const goals = (await db.collection(C.goals).find({ orgId, productId, enabled: true }).toArray()).filter(claudePlansLinkedIn);
  if (goals.length === 0) return { asked: 0, ended: 0 };
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) });
  const rules = rulesFor("linkedin", product);

  const instances = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, goalKey: { $in: goals.map((g) => String(g.key)) }, status: "active" })
    .limit(1000)
    .toArray();
  if (instances.length === 0) return { asked: 0, ended: 0 };
  const ids = instances.map((i) => String(i._id));
  const personIds = instances.map((i) => String(i.personId));

  const [people, actions, replies] = await Promise.all([
    db.collection(C.people).find({ _id: { $in: personIds.map((id) => new ObjectId(id)) } }).toArray(),
    db.collection(C.actions).find({ orgId, goalInstanceId: { $in: ids }, channel: "linkedin" }).project({ goalInstanceId: 1, op: 1, status: 1, sentAt: 1, angle: 1 }).toArray(),
    db.collection(C.events).find({ orgId, productId, personId: { $in: personIds }, type: "reply_received", channel: "linkedin", handled: false }).sort({ ts: 1 }).toArray(),
  ]);
  const personById = new Map(people.map((p) => [String(p._id), p]));

  const asks: Array<{ subjectId: string; payload: Record<string, unknown>; productId: string; campaignKey: string; priority: number }> = [];
  let ended = 0;
  for (const instance of instances) {
    const person = personById.get(String(instance.personId));
    if (!person) continue;
    const need = linkedinNeed({
      instance,
      person,
      actions: actions.filter((a) => String(a.goalInstanceId) === String(instance._id)),
      openReplies: replies.filter((e) => String(e.personId) === String(instance.personId)),
      rules,
      now,
    });
    if (need.kind === "end") {
      await db.collection(C.goalInstances).updateOne(
        { _id: instance._id, status: "active" },
        { $set: { status: "failed", outcome: need.why, endedAt: now } },
      );
      ended++;
      continue;
    }
    if (need.kind === "wait") continue;
    asks.push({
      subjectId: String(instance._id),
      payload: {
        goalInstanceId: String(instance._id),
        personId: String(instance.personId),
        reason: need.kind === "plan" ? need.reason : need.kind,
        ...(need.kind === "answer" ? { eventId: need.eventId } : {}),
      },
      productId,
      campaignKey: String(instance.goalKey),
      priority: need.kind === "answer" ? PRIORITY.urgent : PRIORITY.normal,
    });
  }
  const asked = asks.length ? await enqueueMany(orgId, "linkedin", asks, now) : 0;
  return { asked, ended };
}
