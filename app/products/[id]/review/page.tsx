import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { requireSession, scope } from "../../../tenant";
import { decide, heldMessage } from "../../../actions";
import { Check, CheckCheck, X } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";
import CampaignFilter, { type CampaignOption } from "./campaign-filter";
import PreviewDrawer from "./preview-drawer";

export const dynamic = "force-dynamic";

/** Page sizes on offer. Ten is the default because a reviewer reads, they do not scroll. */
const PER_PAGE = [10, 50, 100, 500] as const;

export default async function Review({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ campaign?: string; page?: string; per?: string }>;
}) {
  const { id } = await params;
  const { campaign, page: pageParam, per: perParam } = await searchParams;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const per = PER_PAGE.includes(Number(perParam) as (typeof PER_PAGE)[number])
    ? Number(perParam)
    : PER_PAGE[0];

  const goals = await db.collection(C.goals).find(s).toArray();

  // Held messages carry a campaign only through their run, so the filter resolves that
  // first rather than trying to join in the query.
  let instanceIds: string[] | undefined;
  if (campaign) {
    const runs = await db
      .collection(C.goalInstances)
      .find({ ...s, goalKey: campaign })
      .project({ _id: 1 })
      .toArray();
    instanceIds = runs.map((r) => String(r._id));
  }

  const query = {
    ...s,
    status: "awaiting_approval",
    ...(instanceIds ? { goalInstanceId: { $in: instanceIds } } : {}),
  };

  const matching = await db.collection(C.actions).countDocuments(query);
  const pages = Math.max(1, Math.ceil(matching / per));
  // A filter change can leave you past the end of the shorter list, which would otherwise
  // read as "nothing waiting" on a campaign that has plenty.
  const current = Math.min(Math.max(1, Number(pageParam) || 1), pages);
  const skip = (current - 1) * per;

  const held = await db
    .collection(C.actions)
    .find(query)
    .sort({ dueAt: 1 })
    .skip(skip)
    .limit(per)
    .toArray();

  const totals = await Promise.all(
    goals.map(async (g) => {
      const runs = await db.collection(C.goalInstances).find({ ...s, goalKey: g.key }).project({ _id: 1 }).toArray();
      return {
        key: String(g.key),
        name: String(g.name),
        count: await db.collection(C.actions).countDocuments({
          ...s,
          status: "awaiting_approval",
          goalInstanceId: { $in: runs.map((r) => String(r._id)) },
        }),
      };
    }),
  );
  const allWaiting = totals.reduce((n, t) => n + t.count, 0);

  const rows = await Promise.all(
    held.map(async (a) => ({
      action: a,
      person: await db.collection(C.people).findOne({ _id: new ObjectId(String(a.personId)) }),
      run: await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(a.goalInstanceId)) }),
    })),
  );

  /** Every list URL is built from the current filter, so one control never resets another. */
  function url(next: { campaign?: string | null; page?: number; per?: number }): string {
    const q = new URLSearchParams();
    const nextCampaign = next.campaign === null ? undefined : (next.campaign ?? campaign);
    if (nextCampaign) q.set("campaign", nextCampaign);
    const nextPer = next.per ?? per;
    if (nextPer !== PER_PAGE[0]) q.set("per", String(nextPer));
    const nextPage = next.page ?? current;
    if (nextPage > 1) q.set("page", String(nextPage));
    const qs = q.toString();
    return `/products/${id}/review${qs ? `?${qs}` : ""}`;
  }

  const options: CampaignOption[] = totals.map((t) => ({
    ...t,
    // Choosing a campaign starts that list at the top; page 4 of the old filter means
    // nothing in the new one.
    href: url({ campaign: t.key, page: 1 }),
  }));

  const first = matching === 0 ? 0 : skip + 1;
  const last = skip + held.length;

  return (
    <>
      <div className="head">
        <div>
          <h1>Review</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {allWaiting === 0
              ? "Campaigns set to hold each message queue them here before anything goes out."
              : `${allWaiting} waiting. Approving returns a message to the send queue, where every guardrail still applies.`}
          </p>
        </div>
        {held.length > 1 && (
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

      <div className="row" style={{ marginBottom: 16 }}>
        {goals.length > 1 && (
          <CampaignFilter
            options={options}
            current={campaign}
            allCount={allWaiting}
            allHref={url({ campaign: null, page: 1 })}
          />
        )}
        <span className="spacer" />
        {matching > 0 && (
          <span className="muted" style={{ fontSize: 13 }}>
            {first}–{last} of {matching}
          </span>
        )}
      </div>

      {held.length === 0 ? (
        <div className="empty">
          <strong>{campaign ? "Nothing waiting in this campaign" : "Nothing waiting"}</strong>
          {allWaiting > 0 && campaign
            ? "Other campaigns have messages to review."
            : "Messages appear here once a campaign set to hold each one has something to send."}
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
                  <th>Due</th>
                  <th className="decision-head">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ action, person, run }) => {
                  const content = (action.content ?? {}) as { subject?: string };
                  const name = String(person?.name ?? person?.primaryEmail ?? "Unknown");
                  const email = String(person?.primaryEmail ?? "");
                  const goalKey = String(run?.goalKey ?? "—");
                  const meta = `${goalKey} · ${String(action.channel)} · angle ${String(action.angle)}`;
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
                      <td className="muted num">
                        {action.dueAt ? new Date(String(action.dueAt)).toISOString().slice(0, 16).replace("T", " ") : "—"}
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <form method="get" className="row">
              {campaign && <input type="hidden" name="campaign" value={campaign} />}
              <label className="pager-per">
                <span className="muted">Per page</span>
                {/* Changing the size lands you on page one — page 12 of tens is page 2 of
                    fifties, and guessing which is worse than starting over. */}
                <select name="per" defaultValue={String(per)}>
                  {PER_PAGE.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <SubmitButton variant="quiet" size="sm" pendingLabel="Loading…">Apply</SubmitButton>
            </form>

            <span className="spacer" />

            <span className="muted" style={{ fontSize: 13 }}>Page {current} of {pages}</span>
            <a
              href={url({ page: current - 1 })}
              className={`btn ghost sm ${current === 1 ? "off" : ""}`}
              aria-disabled={current === 1}
            >
              Previous
            </a>
            <a
              href={url({ page: current + 1 })}
              className={`btn ghost sm ${current === pages ? "off" : ""}`}
              aria-disabled={current === pages}
            >
              Next
            </a>
          </div>
        </>
      )}
    </>
  );
}
