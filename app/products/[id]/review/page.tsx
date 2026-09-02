import { ObjectId } from "mongodb";
import type { Filter, Document } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { requireSession, scope } from "../../../tenant";
import { decide, heldMessage, returnToReview } from "../../../actions";
import { Check, CheckCheck, RotateCcw, X } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";
import { BusyArea, BusyLink, BusyProvider, BusySelect } from "../../../ui/busy";
import { ist, istLong } from "../../../ui/time";
import CampaignFilter, { type CampaignOption } from "./campaign-filter";
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
    label: "Waiting",
    match: { status: "awaiting_approval" },
    blurb: "Nothing has been decided on these yet.",
  },
  approved: {
    label: "Approved",
    match: { status: { $in: ["queued", "sending", "dispatched"] } },
    blurb: "Approved and on their way out. They still pass every guardrail at the moment they send.",
  },
  sent: {
    label: "Sent",
    match: { status: "sent" },
    blurb: "These reached the provider. The message shown is the one that went.",
  },
  blocked: {
    label: "Never sent",
    match: { status: "skipped", skipReason: { $exists: true } },
    blurb:
      "Approved, then stopped on the way out — a cap, a suppression, a closed campaign. Nothing retries these on its own.",
  },
  rejected: {
    label: "Rejected",
    match: { status: "skipped", skipReason: { $exists: false } },
    blurb: "Turned down in review. Nothing was sent.",
  },
  failed: {
    label: "Failed",
    match: { status: "failed" },
    blurb: "The send itself errored. The reason is on each row.",
  },
  all: {
    label: "All",
    match: {},
    blurb: "Every message this product has ever composed.",
  },
} as const;

type ViewKey = keyof typeof VIEWS;
const VIEW_KEYS = Object.keys(VIEWS) as ViewKey[];

/** How each row's state reads, and whether it is worth alarm. */
function statusOf(action: Document): { label: string; tone: string; detail?: string } {
  const status = String(action.status);
  const validation = action.validation as { hardFails?: string[] } | undefined;
  switch (status) {
    case "awaiting_approval":
      return { label: "waiting", tone: "" };
    case "queued": {
      // A message waiting out a full window is not the same as one about to go, and the
      // difference is the only thing anyone wants to know from this row. The date it is
      // waiting for matters as much as the reason: the reason is a snapshot of the limit
      // that stopped it, so without the date a raised cap looks like it did nothing.
      const until = action.dueAt ? new Date(String(action.dueAt)) : undefined;
      if (!action.deferReason) return { label: "approved", tone: "accent", detail: "in the send queue" };
      return {
        label: "approved",
        tone: "accent",
        detail:
          until && until > new Date()
            ? `held until ${ist(until)} — ${String(action.deferReason)} when it was held`
            : `due now — was held by ${String(action.deferReason)}`,
      };
    }
    case "sending":
      return { label: "sending", tone: "accent", detail: "claimed by a send run" };
    case "dispatched":
      return { label: "dispatched", tone: "accent", detail: "provider has it, delivery unconfirmed" };
    case "sent":
      return { label: "sent", tone: "ok", detail: action.confirmedAt ? "delivery confirmed" : undefined };
    case "failed":
      return {
        label: "failed",
        tone: "bad",
        detail: action.error ? String(action.error) : validation?.hardFails?.join("; "),
      };
    case "skipped":
      return action.skipReason
        ? { label: "never sent", tone: "bad", detail: String(action.skipReason) }
        : { label: "rejected", tone: "", detail: "turned down in review" };
    default:
      return { label: status, tone: "" };
  }
}

export default async function Review({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ campaign?: string; view?: string; channel?: string; page?: string; per?: string }>;
}) {
  const { id } = await params;
  const {
    campaign,
    view: viewParam,
    channel: channelParam,
    page: pageParam,
    per: perParam,
  } = await searchParams;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const view: ViewKey = VIEW_KEYS.includes(viewParam as ViewKey) ? (viewParam as ViewKey) : "waiting";
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

  /** Everything except the status view, so the tab counts can be taken against it. */
  const base: Filter<Document> = {
    ...s,
    ...(instanceIds ? { goalInstanceId: { $in: instanceIds } } : {}),
    ...(channelKey ? { channel: channelKey } : {}),
  };
  const query: Filter<Document> = { ...base, ...VIEWS[view].match };

  const matching = await db.collection(C.actions).countDocuments(query);
  const pages = Math.max(1, Math.ceil(matching / per));
  // A filter change can leave you past the end of the shorter list, which would otherwise
  // read as "nothing waiting" on a campaign that has plenty.
  const current = Math.min(Math.max(1, Number(pageParam) || 1), pages);
  const skip = (current - 1) * per;

  const held = await db
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
        await db.collection(C.actions).countDocuments({ ...base, ...VIEWS[key].match }),
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
        ...VIEWS[view].match,
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

  const options: CampaignOption[] = totals.map((t) => ({
    ...t,
    // Choosing a campaign starts that list at the top; page 4 of the old filter means
    // nothing in the new one.
    href: url({ campaign: t.key, page: 1 }),
  }));

  const first = matching === 0 ? 0 : skip + 1;
  const last = skip + held.length;
  const waiting = view === "waiting";

  return (
    <BusyProvider>
      <div className="head">
        <div>
          <h1>Review</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {waiting && allInView === 0
              ? "Campaigns set to hold each message queue them here before anything goes out."
              : waiting
                ? `${allInView} waiting. Approving returns a message to the send queue, where every guardrail still applies.`
                : VIEWS[view].blurb}
          </p>
        </div>
        {view === "blocked" && held.length > 0 && (
          <>
            <div className="spacer" />
            {/* Returns them to review rather than sending them: they were stopped by a
                limit that may still be in force, and the reviewer is the one who decides
                whether the thing that stopped them has actually been dealt with. */}
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
        {waiting && held.length > 1 && (
          <>
            <div className="spacer" />
            <form action={decide}>
              <input type="hidden" name="productId" value={id} />
              <input type="hidden" name="decision" value="approve" />
              {held.map((a) => (
                <input key={String(a._id)} type="hidden" name="ids" value={String(a._id)} />
              ))}
              {/* Says which messages it releases. "All 25 shown" read as "all 25 waiting"
                  on a queue of 137, which is a send you cannot take back. */}
              <SubmitButton variant="quiet" icon={<CheckCheck />} pendingLabel="Approving…">
                Approve this page ({held.length} of {matching})
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

      <BusyArea>
        {held.length === 0 ? (
          <div className="empty">
            <strong>
              {campaign ? `Nothing ${VIEWS[view].label.toLowerCase()} in this campaign` : `Nothing ${VIEWS[view].label.toLowerCase()}`}
            </strong>
            {waiting
              ? "Messages appear here once a campaign set to hold each one has something to send."
              : VIEWS[view].blurb}
          </div>
        ) : (
          <>
            <div className="tw scroll">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Campaign</th>
                    <th>Subject</th>
                    <th>Channel</th>
                    <th>{waiting ? "Due (IST)" : "State"}</th>
                    <th>{waiting ? "Decision" : "When (IST)"}</th>
                    {!waiting && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ action, person, run }) => {
                    const content = (action.content ?? {}) as { subject?: string };
                    const name = String(person?.name ?? person?.primaryEmail ?? "Unknown");
                    const email = String(person?.primaryEmail ?? "");
                    const goalKey = String(run?.goalKey ?? "—");
                    const meta = `${goalKey} · ${String(action.channel)} · angle ${String(action.angle)}`;
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
                        <td>
                          {totals.find((t) => t.key === goalKey)?.name ?? goalKey}
                          <div className="muted" style={{ fontSize: 12.5 }}>angle {String(action.angle)}</div>
                        </td>
                        <td className="cell-wide">{content.subject ?? <span className="muted">no subject</span>}</td>
                        <td><span className="pill">{String(action.channel)}</span></td>

                        {waiting ? (
                          <td className="muted num" title={istLong(action.dueAt as string)}>
                            {ist(action.dueAt as string)}
                          </td>
                        ) : (
                          <td>
                            <span className={`pill ${state.tone}`}>{state.label}</span>
                            {state.detail ? (
                              <div className="muted" style={{ fontSize: 12.5 }}>{state.detail}</div>
                            ) : null}
                          </td>
                        )}

                        {waiting ? (
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
                                {action.status === "skipped" && action.skipReason ? (
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
