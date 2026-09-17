import { Suspense } from "react";
import { ObjectId } from "mongodb";
import type { Filter, Document } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { peopleEngagement } from "@/engine/engagement.js";
import { isReplacedPlan, REPLACED_PLAN } from "@/engine/replaced.js";
import { requireSession, scope } from "../../../tenant";
import { BusyArea, BusyLink, BusyProvider, BusySelect } from "../../../ui/busy";
import { ist, istLong, istShort } from "../../../ui/time";
import CampaignFilter, { type CampaignOption } from "./campaign-filter";
import SearchBox from "./search-box";
import DecisionToast from "./decision-toast";
import ReviewQueue from "./review-queue";
import type { QueueRow } from "./queue-row";

export const dynamic = "force-dynamic";

/** Page sizes on offer. Ten is the default because a reviewer reads, they do not scroll. */
const PER_PAGE = [10, 50, 100, 500] as const;

/**
 * The states a message can be in, as a reviewer thinks of them.
 *
 * Two of these are the same status in the database. A message approved by a human and then
 * stopped by a daily cap is `skipped`, and so is one a human rejected — telling them apart
 * needs `skipReason`, which only the engine writes. Without the split, 85 messages someone
 * approved and released read as 85 they turned down.
 */
const VIEWS = {
  waiting: {
    label: "Pending approval",
    // Everything undecided, whether it is due now or dated for next week.
    //
    // These were two tabs. Both held messages nobody had decided on, both offered the same
    // Approve and Reject, and the only difference between them was the due date — which is
    // a column, not a tab. What that split actually produced was a reviewer approving a
    // message, seeing a new one appear under Scheduled for the same person, and reading it
    // as the decision having been lost. One queue, with the date on the row.
    match: {
      $or: [{ status: "awaiting_approval" }, { status: "queued", reviewedAt: { $exists: false } }],
    },
    blurb: "Waiting on a decision. Approving sends each one on its date — today's go within the minute.",
  },
  approved: {
    label: "Approved",
    // reviewedAt, not status. A queued message is queued whether or not anyone released
    // it, and this tab is the one people read as permission having been given.
    match: { status: { $in: ["queued", "sending", "dispatched"] }, reviewedAt: { $exists: true } },
    blurb: "Approved and on their way out. They still pass every guardrail at the moment they send.",
  },
  sent: {
    label: "Sent",
    match: { status: "sent" },
    blurb: "These reached the provider. The message shown is the one that went.",
  },
  failed: {
    label: "Undelivered",
    // Two statuses, one question. `skipped` with a reason is one of our own limits stopping
    // an approved message; `failed` is the send itself erroring. Both mean nobody received
    // it, so a reviewer asking "what never reached anyone" was checking two tabs for one
    // answer — and only one of the two offered a way back. They are one list now, with the
    // side that stopped each message written on its row.
    match: {
      $or: [{ status: "skipped", skipReason: { $exists: true, $not: REPLACED_PLAN } }, { status: "failed" }],
    },
    blurb:
      "Never reached anyone — stopped by one of our limits, or the send itself errored. Nothing retries these on its own; returning one to review puts it back in front of you.",
  },
  rejected: {
    label: "Rejected",
    match: { status: "skipped", skipReason: { $exists: false } },
    blurb: "Turned down in review. Nothing was sent.",
  },
  // Not a failure and not a decision: the lead's plan changed and its new step took the
  // place of this one. Kept as a record of what the old plan would have sent.
  replaced: {
    label: "Replaced",
    match: { status: "skipped", skipReason: REPLACED_PLAN },
    blurb:
      "Written for a plan that was later replaced for the lead. The new plan's own message took its place, so nothing is missing and none of these need sending.",
  },
  all: {
    label: "All messages",
    match: {},
    blurb: "Every message this product has ever composed.",
  },
} as const;

type ViewKey = keyof typeof VIEWS;
const VIEW_KEYS = Object.keys(VIEWS) as ViewKey[];

/**
 * Which side of the line a message died on.
 *
 * The two failure tabs are one now, and the distinction they carried still matters: ours is
 * a setting somebody here can change, theirs is a wait or a support ticket. Saying it on the
 * row is what keeps merging the tabs from losing it.
 */
type Origin = "ours" | "theirs";

const ORIGIN_LABEL: Record<Origin, string> = { ours: "Stopped here", theirs: "Provider error" };

function failureOrigin(action: Document): Origin {
  // A rule of ours held it: a cap, a suppression, a campaign that had already closed.
  if (String(action.status) === "skipped") return "ours";
  const validation = action.validation as { hardFails?: string[] } | undefined;
  // Our own content check refused to let it out.
  if (validation?.hardFails?.length) return "ours";
  // A message missing its person, channel or template is our bookkeeping, not a refusal
  // from anybody's provider.
  return /^missing /.test(String(action.error ?? "")) ? "ours" : "theirs";
}

/** Whether this message can be put back in front of a reviewer rather than being the end. */
function recoverable(action: Document): boolean {
  const status = String(action.status);
  // A rejection is deliberately not in here. Reviving something a human turned down is an
  // override, not a recovery.
  // Nor is a replaced plan's message: the new plan's step already took its place, so
  // bringing this one back would mail the lead twice.
  return (
    status === "failed" ||
    (status === "skipped" && Boolean(action.skipReason) && !isReplacedPlan(action.skipReason))
  );
}

/** How each row's state reads, and whether it is worth alarm. */
function statusOf(action: Document): { label: string; tone: string; detail?: string; origin?: Origin } {
  const status = String(action.status);
  const validation = action.validation as { hardFails?: string[] } | undefined;
  switch (status) {
    case "awaiting_approval":
      return { label: "Pending", tone: "" };
    case "queued": {
      // "queued" is where every message starts, not only where an approved one waits. A
      // row that nobody has looked at read as "approved · in the send queue", which is the
      // most dangerous thing this screen could say: it claims a human released mail to a
      // stranger when no human has seen it. The gate runs when a send run claims the
      // message, so there is always a window where both meanings share one status, and
      // reviewedAt is the only thing that tells them apart.
      if (!action.reviewedAt) {
        return { label: "Scheduled", tone: "", detail: "dated for later, no decision yet" };
      }
      // A message waiting out a full window is not the same as one about to go, and the
      // difference is the only thing anyone wants to know from this row. The date it is
      // waiting for matters as much as the reason: the reason is a snapshot of the limit
      // that stopped it, so without the date a raised cap looks like it did nothing.
      const until = action.dueAt ? new Date(String(action.dueAt)) : undefined;
      if (!action.deferReason) {
        // A future date is a wait whatever set it. "In the send queue" over a three-hour
        // quiet-hours hold is what made fifty approved mails look stuck on 16 September.
        if (until && until > new Date()) {
          const why = action.dueReason ? ` — ${String(action.dueReason)}` : "";
          return { label: "Approved", tone: "accent", detail: `sends ${ist(until)}${why}` };
        }
        return { label: "Approved", tone: "accent", detail: "in the send queue" };
      }
      return {
        label: "Approved",
        tone: "accent",
        detail:
          until && until > new Date()
            ? `held until ${ist(until)} — ${String(action.deferReason)} when it was held`
            : `due now — was held by ${String(action.deferReason)}`,
      };
    }
    case "sending":
      return { label: "Sending", tone: "accent", detail: "claimed by a send run" };
    case "dispatched":
      return { label: "Dispatched", tone: "accent", detail: "provider has it, delivery unconfirmed" };
    case "sent":
      return { label: "Sent", tone: "ok", detail: action.confirmedAt ? "delivery confirmed" : undefined };
    case "failed":
      return {
        label: "Failed",
        tone: "bad",
        detail: action.error ? String(action.error) : validation?.hardFails?.join("; "),
        origin: failureOrigin(action),
      };
    case "skipped":
      // One word for both halves of the failed list. A message a cap stopped and one the
      // provider refused are the same fact to the person reading — nobody got it — and the
      // origin pill beside this says which of the two it was.
      //
      // Except a replaced plan's message, which nobody was meant to get: its lead's new
      // plan sends its own step instead. Red "Failed" on it read as an error that was not.
      if (isReplacedPlan(action.skipReason)) {
        return { label: "Replaced", tone: "", detail: "the lead's new plan sends its own message instead" };
      }
      return action.skipReason
        ? { label: "Failed", tone: "bad", detail: String(action.skipReason), origin: "ours" }
        : { label: "Rejected", tone: "", detail: "turned down in review" };
    default:
      return { label: status, tone: "" };
  }
}

export default async function Review({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    campaign?: string;
    view?: string;
    channel?: string;
    page?: string;
    per?: string;
    q?: string;
    approved?: string;
    rejected?: string;
  }>;
}) {
  const { id } = await params;
  const {
    campaign,
    view: viewParam,
    channel: channelParam,
    page: pageParam,
    per: perParam,
    q: queryParam,
  } = await searchParams;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  // "Never sent" and "Failed" used to be separate tabs. A bookmark, a notification or a
  // browser's back button can still ask for the old one by name.
  // Old tabs that bookmarks, notifications and back buttons still ask for by name.
  // "blocked" was renamed to the undelivered list; "scheduled" was merged into the queue.
  const RENAMED: Record<string, ViewKey> = { blocked: "failed", scheduled: "waiting" };
  const asked = viewParam ? (RENAMED[viewParam] ?? viewParam) : viewParam;
  const view: ViewKey = VIEW_KEYS.includes(asked as ViewKey) ? (asked as ViewKey) : "waiting";
  const per = PER_PAGE.includes(Number(perParam) as (typeof PER_PAGE)[number])
    ? Number(perParam)
    : PER_PAGE[0];

  const [goals, channels] = await Promise.all([
    db.collection(C.goals).find(s).toArray(),
    db.collection(C.channels).find(s).toArray(),
  ]);

  // Held messages carry a campaign only through their run, so the filter resolves that
  // first rather than trying to join in the query.
  const runsFor = async (goalKey: string) =>
    (await db.collection(C.goalInstances).find({ ...s, goalKey }).project({ _id: 1 }).toArray()).map((r) =>
      String(r._id),
    );

  const instanceIds = campaign ? await runsFor(campaign) : undefined;
  const channelKey = channels.some((c) => String(c.key) === channelParam) ? channelParam : undefined;
  // The filter is by kind, and a product with four mailboxes has four channels of one kind.
  // One pill per kind, or the row reads "email email email email" and all four light up.
  const channelKinds = [...new Set(channels.map((c) => String(c.key)))];

  // Which mailbox each row will actually leave from.
  //
  // The row said "email", which is the kind of channel and not the sender — true of every
  // row on the page and therefore worth nothing. Once a product sends from several
  // mailboxes that is the fact somebody approving needs: the same message from a cold
  // outreach address and from the address the customer already knows are different
  // decisions, and the queue was the one place that could not tell you which it was.
  const senderById = new Map(
    channels.map((c) => [String(c._id), String(c.from ?? `${String(c.key)} · provider default sender`)]),
  );
  // The From header itself, for the inbox preview. Absent rather than the label above, so
  // the preview can say the provider picks the sender instead of showing a label as one.
  const fromById = new Map(channels.filter((c) => c.from).map((c) => [String(c._id), String(c.from)]));

  // One box over two collections. The reviewer hunting a row does not know or care whether
  // what they remember is on the person or on the message, so a name, an email address and
  // a subject line all answer to the same search.
  const search = (queryParam ?? "").trim();
  const searchFilter = search
    ? await (async (): Promise<Filter<Document>> => {
        // Escaped, because a lead's company really can be called "C++" and a regex built
        // from raw input either throws or matches the wrong rows.
        const needle = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const people = await db
          .collection(C.people)
          .find({ ...s, $or: [{ name: needle }, { primaryEmail: needle }, { companyDomain: needle }] })
          .project({ _id: 1 })
          .toArray();
        return {
          $or: [
            { personId: { $in: people.map((p) => String(p._id)) } },
            { "content.subject": needle },
          ],
        };
      })()
    : undefined;

  /** Everything except the status view, so the tab counts can be taken against it. */
  const base: Filter<Document> = {
    ...s,
    ...(instanceIds ? { goalInstanceId: { $in: instanceIds } } : {}),
    ...(channelKey ? { channel: channelKey } : {}),
    ...(searchFilter ? { $and: [searchFilter] } : {}),
  };
  // The literal VIEWS object infers its $or as a readonly tuple, which the driver's
  // Filter type will not take. The shape is right; only its mutability is not.
  const query: Filter<Document> = { ...base, ...(VIEWS[view].match as Filter<Document>) };

  const matching = await db.collection(C.actions).countDocuments(query);
  const pages = Math.max(1, Math.ceil(matching / per));
  // A filter change can leave you past the end of the shorter list, which would otherwise
  // read as "nothing waiting" on a campaign that has plenty.
  const current = Math.min(Math.max(1, Number(pageParam) || 1), pages);
  const skip = (current - 1) * per;

  // Whose messages jump the queue.
  //
  // A reviewer works down a list of fifty identical rows in date order, and the message to
  // the one person who clicked yesterday sits at position thirty-one because that is when
  // it happened to be written. Someone who has just responded is the only lead in the queue
  // whose interest expires, so their message is lifted to the top of it — the order is
  // still oldest-first inside each group, so nothing is buried by the lift.
  const lifted = (
    await db
      .collection(C.people)
      .find({ ...s, "temp.band": "hot" }, { projection: { _id: 1 } })
      .toArray()
  ).map((p) => String(p._id));

  // The undecided queue holds both halves now — at the gate and dated for later — so a
  // message to someone who has just clicked is lifted whichever half it is in.
  const held =
    view === "waiting" && lifted.length > 0
      ? await db
          .collection(C.actions)
          .aggregate([
            { $match: query },
            { $addFields: { lift: { $cond: [{ $in: ["$personId", lifted] }, 0, 1] } } },
            { $sort: { lift: 1, dueAt: 1 } },
            { $skip: skip },
            { $limit: per },
          ])
          .toArray()
      : await db
          .collection(C.actions)
          .find(query)
          // Newest first everywhere but the queue: history is read from the top, whereas a
          // review queue is worked oldest-first.
          .sort(view === "waiting" ? { dueAt: 1 } : { sentAt: -1, reviewedAt: -1, dueAt: -1 })
          .skip(skip)
          .limit(per)
          .toArray();

  const viewCounts = Object.fromEntries(
    await Promise.all(
      VIEW_KEYS.map(async (key) => [
        key,
        await db.collection(C.actions).countDocuments({ ...base, ...(VIEWS[key].match as Filter<Document>) }),
      ]),
    ),
  ) as Record<ViewKey, number>;

  // Campaign counts follow the status you are looking at. A campaign showing "12" under
  // Waiting and "12" under Sent would be the same twelve, which is not what it means.
  const totals = await Promise.all(
    goals.map(async (g) => ({
      key: String(g.key),
      name: String(g.name),
      count: await db.collection(C.actions).countDocuments({
        ...s,
        ...(channelKey ? { channel: channelKey } : {}),
        goalInstanceId: { $in: await runsFor(String(g.key)) },
        ...(VIEWS[view].match as Filter<Document>),
      }),
    })),
  );
  const allInView = viewCounts[view];

  /** Every list URL is built from the current filter, so one control never resets another. */
  function url(next: {
    campaign?: string | null;
    view?: ViewKey;
    channel?: string | null;
    page?: number;
    per?: number;
    q?: string | null;
  }): string {
    const q = new URLSearchParams();
    const nextCampaign = next.campaign === null ? undefined : (next.campaign ?? campaign);
    if (nextCampaign) q.set("campaign", nextCampaign);
    const nextView = next.view ?? view;
    if (nextView !== "waiting") q.set("view", nextView);
    const nextChannel = next.channel === null ? undefined : (next.channel ?? channelKey);
    if (nextChannel) q.set("channel", nextChannel);
    const nextPer = next.per ?? per;
    if (nextPer !== PER_PAGE[0]) q.set("per", String(nextPer));
    const nextPage = next.page ?? current;
    if (nextPage > 1) q.set("page", String(nextPage));
    const nextSearch = next.q === null ? "" : (next.q ?? search);
    if (nextSearch) q.set("q", nextSearch);
    const qs = q.toString();
    return `/products/${id}/review${qs ? `?${qs}` : ""}`;
  }

  const rows = await Promise.all(
    held.map(async (a) => ({
      action: a,
      person: await db.collection(C.people).findOne({ _id: new ObjectId(String(a.personId)) }),
      run: await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(a.goalInstanceId)) }),
    })),
  );

  // What each of these people has already done. Approving a message to someone who clicked
  // an hour ago is a different decision from approving one to someone who has never
  // responded, and the queue was showing both as the same row.
  const responded = await peopleEngagement(orgId, id, rows.map((r) => String(r.action.personId)));
  const liftedHere = rows.filter((r) => lifted.includes(String(r.action.personId))).length;

  const options: CampaignOption[] = totals.map((t) => ({
    ...t,
    // Choosing a campaign starts that list at the top; page 4 of the old filter means
    // nothing in the new one.
    href: url({ campaign: t.key, page: 1 }),
  }));

  const first = matching === 0 ? 0 : skip + 1;
  const last = skip + held.length;
  const waiting = view === "waiting";
  // The filters this reader is looking through, so a decision hands them back the same list
  // rather than dropping them at the default view with their campaign filter gone.
  const back = (() => {
    const q = new URLSearchParams();
    if (view !== "waiting") q.set("view", view);
    if (campaign) q.set("campaign", campaign);
    if (channelParam) q.set("channel", channelParam);
    if (perParam) q.set("per", String(perParam));
    if (search) q.set("q", search);
    return q.toString();
  })();
  /** Every filter except the search itself, so searching does not drop the tab you are on. */
  const searchFilters = (() => {
    const q = new URLSearchParams();
    if (view !== "waiting") q.set("view", view);
    if (campaign) q.set("campaign", campaign);
    if (channelKey) q.set("channel", channelKey);
    if (per !== PER_PAGE[0]) q.set("per", String(per));
    return q.toString();
  })();
  // One undecided queue now, so the decision controls belong to exactly one tab.
  const decidable = waiting;
  const now = Date.now();

  const queue: QueueRow[] = rows.map(({ action, person, run }) => {
    const content = (action.content ?? {}) as { subject?: string; slotText?: string };
    const goalKey = String(run?.goalKey ?? "—");
    const engagement = responded.get(String(action.personId));
    const state = statusOf(action);
    // What happened, not merely when it was due: a sent message is dated by its send, a
    // decided one by its decision. The queue is dated by when it will go.
    const when = (decidable ? action.dueAt : (action.sentAt ?? action.reviewedAt ?? action.dueAt)) as string;
    return {
      id: String(action._id),
      name: String(person?.name ?? person?.primaryEmail ?? "Unknown"),
      email: String(person?.primaryEmail ?? ""),
      campaign: totals.find((t) => t.key === goalKey)?.name ?? goalKey,
      angle: action.angle ? String(action.angle) : "",
      channel: String(action.channel),
      // The mailbox, not the kind of channel: once cold outreach and the product's own
      // sender are both connected, which address it leaves from is part of the decision.
      sender: senderById.get(String(action.channelId)) ?? String(action.channel),
      from: fromById.get(String(action.channelId)),
      subject: content.subject || undefined,
      opening: content.slotText || undefined,
      decidable,
      whenShort: istShort(when),
      whenLong: istLong(when),
      dueNow: new Date(String(action.dueAt)).getTime() <= now,
      lifted: lifted.includes(String(action.personId)),
      band: (person?.temp as { band?: string } | undefined)?.band,
      replied: (engagement?.replied ?? 0) > 0,
      clicked: (engagement?.clicked ?? 0) > 0,
      engagedAgo: ago(engagement?.lastRepliedAt ?? engagement?.lastClickedAt),
      state: { ...state, origin: state.origin ? ORIGIN_LABEL[state.origin] : undefined },
      recoverable: recoverable(action),
    };
  });

  // Search, campaign and channel. They sit at the head of the list they narrow, so the
  // queue can start right under the tabs and give the open message the height.
  const filters = (
    <>
      {/* Still a real GET form underneath — see the component. */}
      <SearchBox action={`/products/${id}/review`} hiddenQuery={searchFilters} current={search} />
      {goals.length > 1 || channelKinds.length > 1 ? (
        <div className="rq-filter-row">
          {goals.length > 1 && (
            <CampaignFilter
              options={options}
              current={campaign}
              allCount={allInView}
              allHref={url({ campaign: null, page: 1 })}
            />
          )}
          {/* Only worth the space once a product actually sends more than one way. */}
          {channelKinds.length > 1 && (
            <BusySelect
              value={channelKey ?? ""}
              ariaLabel="Channel"
              width={120}
              options={[
                { value: "", label: "All channels", href: url({ channel: null, page: 1 }) },
                ...channelKinds.map((kind) => ({ value: kind, label: kind, href: url({ channel: kind, page: 1 }) })),
              ]}
            />
          )}
        </div>
      ) : null}
    </>
  );

  return (
    <BusyProvider>
      <h1 className="sr-only">Review</h1>
      {/* A toast rather than a line under the title: a sentence above a list that has just
          redrawn is a sentence nobody sees. */}
      <Suspense fallback={null}>
        <DecisionToast />
      </Suspense>

      {/* The states, as one row. Approving used to make a message vanish from the only
          screen that had ever shown it, so "what happened to the batch I released" was a
          question nothing in the product could answer. What each one holds is on hover. */}
      <div className="tabs rq-tabs" role="tablist">
        {VIEW_KEYS.map((key) => (
          <BusyLink
            key={key}
            href={url({ view: key, page: 1 })}
            className={key === view ? "on" : undefined}
            role="tab"
            aria-selected={key === view}
            title={key === "waiting" ? "Waiting on a decision. Approving sends each one on its date — today's go within the minute." : VIEWS[key].blurb}
          >
            {VIEWS[key].label}
            {viewCounts[key] ? <span className="tab-count">{viewCounts[key]}</span> : null}
          </BusyLink>
        ))}
      </div>

      <BusyArea>
        {held.length === 0 ? (
          <>
            <div className="rq-filters rq-filters-bare">{filters}</div>
            <div className="empty">
              <strong>
                {search
                  ? `No ${VIEWS[view].label.toLowerCase()} matches “${search}”`
                  : campaign
                    ? `Nothing ${VIEWS[view].label.toLowerCase()} in this campaign`
                    : `Nothing ${VIEWS[view].label.toLowerCase()}`}
              </strong>
              {search
                ? "Recipient name, email address and subject line are all searched. Clear the search to see the rest."
                : waiting
                  ? "Messages appear here once a campaign set to hold each one has something to send."
                  : VIEWS[view].blurb}
            </div>
          </>
        ) : (
          <ReviewQueue
            productId={id}
            rows={queue}
            back={back}
            grouped={decidable && liftedHere > 0}
            selectable={decidable ? "decide" : view === "failed" || view === "all" ? "return" : false}
            filters={filters}
            pager={{
              first,
              last,
              total: matching,
              current,
              pages,
              prevHref: url({ page: Math.max(1, current - 1) }),
              nextHref: url({ page: Math.min(pages, current + 1) }),
              per,
              // Changing the size lands you on page one — page 12 of tens is page 2 of fifties.
              perOptions: PER_PAGE.map((n) => ({ value: String(n), label: `${n} / page`, href: url({ per: n, page: 1 }) })),
            }}
          />
        )}
      </BusyArea>
    </BusyProvider>
  );
}

/**
 * How long ago, in the units a person would use. An exact timestamp is the wrong shape for
 * this decision — "clicked 40 minutes ago" is a reason to act now, and "2026-09-04 09:27"
 * has to be worked out before it means the same thing.
 */
function ago(at?: Date): string {
  if (!at) return "";
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  // Short units: this sits in a chip beside a name, where "28 hours ago" took the whole line.
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
