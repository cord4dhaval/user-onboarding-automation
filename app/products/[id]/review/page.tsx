import { Suspense } from "react";
import { ObjectId } from "mongodb";
import type { Filter, Document } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { peopleEngagement } from "@/engine/engagement.js";
import { requireSession, scope } from "../../../tenant";
import { decide, heldMessage, returnToReview } from "../../../actions";
import { Check, CheckCheck, Flame, MessageSquare, MousePointerClick, RotateCcw, X } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";
import { BusyArea, BusyLink, BusyProvider, BusySelect } from "../../../ui/busy";
import { ist, istLong } from "../../../ui/time";
import CampaignFilter, { type CampaignOption } from "./campaign-filter";
import SearchBox from "./search-box";
import DecisionToast from "./decision-toast";
import PreviewDrawer from "./preview-drawer";

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
      $or: [{ status: "skipped", skipReason: { $exists: true } }, { status: "failed" }],
    },
    blurb:
      "Never reached anyone — stopped by one of our limits, or the send itself errored. Nothing retries these on its own; returning one to review puts it back in front of you.",
  },
  rejected: {
    label: "Rejected",
    match: { status: "skipped", skipReason: { $exists: false } },
    blurb: "Turned down in review. Nothing was sent.",
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
  return status === "failed" || (status === "skipped" && Boolean(action.skipReason));
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
      if (!action.deferReason) return { label: "Approved", tone: "accent", detail: "in the send queue" };
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
  // Which half of that queue goes out on this send run, and which is dated for later. The
  // bulk button has to say both, or "approve this page" reads as "send all of these now".
  const now = Date.now();
  const dueNow = held.filter((a) => new Date(String(a.dueAt)).getTime() <= now).length;
  const later = held.length - dueNow;

  return (
    <BusyProvider>
      <div className="head">
        <div>
          <h1>Review</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {waiting && allInView === 0
              ? "Campaigns set to hold each message queue them here before anything goes out."
              : waiting
                ? `${allInView} pending. Approving returns a message to the send queue, where every guardrail still applies.`
                : VIEWS[view].blurb}
          </p>
          {/* Said as a toast rather than as a line under the title. A sentence that appears
              above a list which has just redrawn is a sentence nobody sees; it also stayed
              in the address bar, so a refresh re-announced a decision made an hour ago. */}
          <Suspense fallback={null}>
            <DecisionToast />
          </Suspense>
        </div>
        {view === "failed" && held.length > 0 && (
          <>
            <div className="spacer" />
            {/* Returns them to review rather than resending them: whatever stopped them —
                our limit or the provider's refusal — may still be in force, and the
                reviewer is the one who decides whether it has actually been dealt with. */}
            <form action={returnToReview}>
              <input type="hidden" name="productId" value={id} />
              {held.map((a) => (
                <input key={String(a._id)} type="hidden" name="ids" value={String(a._id)} />
              ))}
              <SubmitButton variant="quiet" icon={<RotateCcw />} pendingLabel="Returning…">
                Return this page to review ({held.length} of {matching})
              </SubmitButton>
            </form>
          </>
        )}
        {decidable && held.length > 1 && (
          <>
            <div className="spacer" />
            <form action={decide}>
              <input type="hidden" name="productId" value={id} />
              <input type="hidden" name="decision" value="approve" />
              <input type="hidden" name="back" value={back} />
              {held.map((a) => (
                <input key={String(a._id)} type="hidden" name="ids" value={String(a._id)} />
              ))}
              {/* Says which messages it releases, and when they go. "All 25 shown" read as
                  "all 25 waiting" on a queue of 137, which is a send you cannot take back —
                  and on the scheduled list the same words hid the fact that approving there
                  releases mail dated days out. */}
              <SubmitButton variant="quiet" icon={<CheckCheck />} pendingLabel="Approving…">
                {later === 0
                  ? `Approve page — sends ${dueNow} now`
                  : dueNow === 0
                    ? `Approve page — ${later} send on their dates`
                    : `Approve page — ${dueNow} now, ${later} on their dates`}
              </SubmitButton>
            </form>
          </>
        )}
      </div>

      {/* The states, as one row. Approving used to make a message vanish from the only
          screen that had ever shown it, so "what happened to the batch I released" was a
          question nothing in the product could answer. */}
      <div className="tabs" role="tablist">
        {VIEW_KEYS.map((key) => (
          <BusyLink
            key={key}
            href={url({ view: key, page: 1 })}
            className={key === view ? "on" : undefined}
            role="tab"
            aria-selected={key === view}
          >
            {VIEWS[key].label}
            {viewCounts[key] ? <span className="tab-count">{viewCounts[key]}</span> : null}
          </BusyLink>
        ))}
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        {/* Still a real GET form underneath — see the component. The debounce is an
            enhancement on top of it, not the thing that makes it work. */}
        <SearchBox
          action={`/products/${id}/review`}
          hiddenQuery={searchFilters}
          current={search}
        />
        {goals.length > 1 && (
          <CampaignFilter
            options={options}
            current={campaign}
            allCount={allInView}
            allHref={url({ campaign: null, page: 1 })}
          />
        )}
        {/* Only worth the space once a product actually sends more than one way. */}
        {channels.length > 1 && (
          <div className="seg" role="tablist" aria-label="Channel">
            <BusyLink
              className={!channelKey ? "on" : ""}
              href={url({ channel: null, page: 1 })}
            >
              All channels
            </BusyLink>
            {channels.map((c) => (
              <BusyLink
                key={String(c._id)}
                className={channelKey === String(c.key) ? "on" : ""}
                href={url({ channel: String(c.key), page: 1 })}
              >
                {String(c.key)}
              </BusyLink>
            ))}
          </div>
        )}
        <span className="spacer" />
        {matching > 0 && (
          <span className="muted" style={{ fontSize: 13 }}>
            {first}–{last} of {matching}
          </span>
        )}
      </div>

      {decidable && liftedHere > 0 && (
        <div className="note">
          <p style={{ margin: 0 }}>
            <Flame size={14} /> <strong>{liftedHere}</strong>{" "}
            {liftedHere === 1 ? "message on this page is" : "messages on this page are"} going to someone who has
            just clicked or written back. They are at the top of the queue — their interest is the
            thing on this page with a shelf life.
          </p>
        </div>
      )}

      <BusyArea>
        {held.length === 0 ? (
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
        ) : (
          <>
            <div className="tw scroll">
              <table>
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Engagement</th>
                    <th>Campaign</th>
                    <th>Subject</th>
                    <th>Sending from</th>
                    <th>{decidable ? "Scheduled (IST)" : "Status"}</th>
                    <th>{decidable ? "Actions" : "Updated (IST)"}</th>
                    {!decidable && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ action, person, run }) => {
                    const content = (action.content ?? {}) as { subject?: string };
                    const name = String(person?.name ?? person?.primaryEmail ?? "Unknown");
                    const email = String(person?.primaryEmail ?? "");
                    const goalKey = String(run?.goalKey ?? "—");
                    const sender = senderById.get(String(action.channelId)) ?? String(action.channel);
                    const meta = `${goalKey} · ${sender} · angle ${String(action.angle)}`;
                    const state = statusOf(action);
                    // What happened, not merely when it was due: a sent message is dated by
                    // its send, a decided one by its decision.
                    const when = action.sentAt ?? action.reviewedAt ?? action.dueAt;
                    return (
                      <tr key={String(action._id)}>
                        <td>
                          <strong>{name}</strong>
                          <div className="muted" style={{ fontSize: 12.5 }}>{email}</div>
                        </td>
                        {/* The column that turns a queue into a set of decisions. Everything
                            else on this row describes the message; this one describes the
                            person it is going to. */}
                        <td>
                          <Signal
                            temp={person?.temp as { band?: string } | undefined}
                            engagement={responded.get(String(action.personId))}
                          />
                        </td>
                        <td>
                          {totals.find((t) => t.key === goalKey)?.name ?? goalKey}
                          <div className="muted" style={{ fontSize: 12.5 }}>angle {String(action.angle)}</div>
                        </td>
                        <td className="cell-wide">{content.subject ?? <span className="muted">no subject</span>}</td>
                        {/* The mailbox, not the kind of channel. "email" was true of every
                            row on the page; which address it leaves from is the thing that
                            differs, and once cold outreach and the product's own sender are
                            both connected it is the difference somebody is approving. */}
                        <td>
                          <span className="pill">{String(action.channel)}</span>
                          <div className="muted" style={{ fontSize: 12.5 }}>{sender}</div>
                        </td>

                        {decidable ? (
                          <td className="num" title={istLong(action.dueAt as string)}>
                            <div className="muted">{ist(action.dueAt as string)}</div>
                            {/* The distinction the Scheduled tab used to carry. Approving a
                                row marked "due now" puts mail in front of someone within the
                                minute; approving one dated next week does not. */}
                            <span className={`pill ${new Date(String(action.dueAt)).getTime() <= now ? "hot" : ""}`}>
                              {new Date(String(action.dueAt)).getTime() <= now ? "Due now" : "Scheduled"}
                            </span>
                          </td>
                        ) : (
                          <td>
                            <div className="state-pills">
                              <span className={`pill ${state.tone}`}>{state.label}</span>
                              {/* Which side stopped it. The two used to be two tabs; now the
                                  row carries the difference the tabs did. */}
                              {state.origin ? (
                                <span className="pill">{ORIGIN_LABEL[state.origin]}</span>
                              ) : null}
                            </div>
                            {/* A provider error is a line of JSON. Fifty of them printed in
                                full turned the list into a wall nobody could read down, so
                                it is clamped and the whole thing is in the tooltip. */}
                            {state.detail ? (
                              <div className="state-why" title={state.detail}>{state.detail}</div>
                            ) : null}
                          </td>
                        )}

                        {decidable ? (
                          <td>
                            <div className="row-actions">
                              <PreviewDrawer
                                productId={id}
                                actionId={String(action._id)}
                                personName={name}
                                personEmail={email}
                                meta={meta}
                                fetchMessage={heldMessage}
                              />
                              <form action={decide}>
                                <input type="hidden" name="back" value={back} />
                                <input type="hidden" name="productId" value={id} />
                                <input type="hidden" name="ids" value={String(action._id)} />
                                <SubmitButton
                                  name="decision"
                                  value="approve"
                                  size="sm"
                                  icon={<Check />}
                                  pendingLabel="Sending…"
                                >
                                  Approve
                                </SubmitButton>
                                <SubmitButton name="decision" value="reject" variant="quiet" size="sm" icon={<X />}>
                                  Reject
                                </SubmitButton>
                              </form>
                            </div>
                          </td>
                        ) : (
                          <>
                            <td className="muted num" title={istLong(when as string)}>
                              {ist(when as string)}
                            </td>
                            <td>
                              <div className="row-actions">
                                <PreviewDrawer
                                  productId={id}
                                  actionId={String(action._id)}
                                  personName={name}
                                  personEmail={email}
                                  meta={meta}
                                  fetchMessage={heldMessage}
                                />
                                {recoverable(action) ? (
                                  <form action={returnToReview}>
                                    <input type="hidden" name="productId" value={id} />
                                    <input type="hidden" name="ids" value={String(action._id)} />
                                    <SubmitButton
                                      variant="quiet"
                                      size="sm"
                                      icon={<RotateCcw />}
                                      pendingLabel="Returning…"
                                    >
                                      Return to review
                                    </SubmitButton>
                                  </form>
                                ) : null}
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <label className="pager-per">
                <span className="muted">Per page</span>
                {/* Changing the size lands you on page one — page 12 of tens is page 2 of
                    fifties, and guessing which is worse than starting over. It applies on
                    change: an Apply button next to a select is a second click for a decision
                    already made. */}
                <BusySelect
                  value={String(per)}
                  options={PER_PAGE.map((n) => ({
                    value: String(n),
                    label: String(n),
                    href: url({ per: n, page: 1 }),
                  }))}
                />
              </label>

              <span className="spacer" />

              <span className="muted" style={{ fontSize: 13 }}>Page {current} of {pages}</span>
              <BusyLink
                href={url({ page: current - 1 })}
                  className={`btn ghost sm ${current === 1 ? "off" : ""}`}
                disabled={current === 1}
              >
                Previous
              </BusyLink>
              <BusyLink
                href={url({ page: current + 1 })}
                  className={`btn ghost sm ${current === pages ? "off" : ""}`}
                disabled={current === pages}
              >
                Next
              </BusyLink>
            </div>
          </>
        )}
      </BusyArea>
    </BusyProvider>
  );
}

/**
 * What the person on this row has already done about us.
 *
 * A reviewer approving fifty messages needs one thing the queue never told them: which of
 * these people are already interested. The temperature is the engine's own reading, and the
 * line under it is the evidence for that reading, because "hot" without a reason is a colour
 * rather than a fact.
 */
function Signal({
  temp,
  engagement,
}: {
  temp?: { band?: string };
  engagement?: { clicked: number; replied: number; lastClickedAt?: Date; lastRepliedAt?: Date };
}) {
  const band = temp?.band ? String(temp.band) : undefined;
  const clicked = engagement?.clicked ?? 0;
  const replied = engagement?.replied ?? 0;

  if (!clicked && !replied) {
    return (
      <>
        {band && band !== "cold" ? <span className={`pill ${band}`}>{band}</span> : null}
        <div className="muted" style={{ fontSize: 12.5 }}>no response yet</div>
      </>
    );
  }

  return (
    <>
      <div className="responded">
        {replied > 0 && (
          <span className="pill ok"><MessageSquare /> replied</span>
        )}
        {clicked > 0 && (
          <span className="pill hot"><MousePointerClick /> clicked</span>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {ago(engagement?.lastRepliedAt ?? engagement?.lastClickedAt)}
      </div>
    </>
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
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
