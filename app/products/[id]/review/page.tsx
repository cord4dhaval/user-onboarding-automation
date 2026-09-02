import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { requireSession, scope } from "../../../tenant";
import { decide } from "../../../actions";
import { Check, CheckCheck, X } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";

export const dynamic = "force-dynamic";

export default async function Review({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { id } = await params;
  const { campaign } = await searchParams;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

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

  const held = await db
    .collection(C.actions)
    .find({
      ...s,
      status: "awaiting_approval",
      ...(instanceIds ? { goalInstanceId: { $in: instanceIds } } : {}),
    })
    .sort({ dueAt: 1 })
    .limit(25)
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
              <SubmitButton variant="quiet" icon={<CheckCheck />} pendingLabel="Approving…">Approve all {held.length} shown</SubmitButton>
            </form>
          </>
        )}
      </div>

      {goals.length > 1 && (
        <div className="row" style={{ marginBottom: 18 }}>
          <a
            href={`/products/${id}/review`}
            className={`pill ${!campaign ? "accent" : ""}`}
            style={{ textDecoration: "none" }}
          >
            All ({allWaiting})
          </a>
          {totals.map((t) => (
            <a
              key={t.key}
              href={`/products/${id}/review?campaign=${encodeURIComponent(t.key)}`}
              className={`pill ${campaign === t.key ? "accent" : ""}`}
              style={{ textDecoration: "none" }}
            >
              {t.name} ({t.count})
            </a>
          ))}
        </div>
      )}

      {held.length === 0 ? (
        <div className="empty">
          <strong>{campaign ? "Nothing waiting in this campaign" : "Nothing waiting"}</strong>
          {allWaiting > 0 && campaign
            ? "Other campaigns have messages to review."
            : "Messages appear here once a campaign set to hold each one has something to send."}
        </div>
      ) : (
        rows.map(({ action, person, run }) => {
          const content = (action.content ?? {}) as { subject?: string; bodyMd?: string; bodyHtml?: string };
          return (
            <div className="card" key={String(action._id)} style={{ marginBottom: 16 }}>
              <div className="head" style={{ marginBottom: 12 }}>
                <div>
                  <strong>{String(person?.name ?? person?.primaryEmail ?? "Unknown")}</strong>{" "}
                  <span className="muted">{String(person?.primaryEmail ?? "")}</span>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {String(run?.goalKey ?? "—")} · {String(action.channel)} · angle {String(action.angle)}
                  </div>
                </div>
                <span className="spacer" />
                <form action={decide} className="row">
                  <input type="hidden" name="productId" value={id} />
                  <input type="hidden" name="ids" value={String(action._id)} />
                  <SubmitButton name="decision" value="approve" size="sm" icon={<Check />} pendingLabel="Sending…">Approve</SubmitButton>
                  <SubmitButton name="decision" value="reject" variant="quiet" size="sm" icon={<X />}>Reject</SubmitButton>
                </form>
              </div>

              <div className="preview">
                {content.subject && (
                  <div className="preview-head"><span className="k">Subject</span> <strong>{content.subject}</strong></div>
                )}
                {/* Approving sends this exact mail, so show the mail — the markdown behind
                    it reads nothing like what lands in the inbox. */}
                {content.bodyHtml ? (
                  <iframe
                    title={`Message to ${String(person?.primaryEmail ?? "this person")}`}
                    srcDoc={content.bodyHtml}
                    className="preview-frame"
                  />
                ) : (
                  <div className="preview-body">{content.bodyMd}</div>
                )}
              </div>

              {action.rationale ? (
                <p className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>
                  Why this: {String(action.rationale)}
                </p>
              ) : null}
            </div>
          );
        })
      )}
    </>
  );
}
