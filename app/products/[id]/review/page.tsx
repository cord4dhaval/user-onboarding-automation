import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { requireSession, scope } from "../../../tenant";
import { decide } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const held = await db
    .collection(C.actions)
    .find({ ...s, status: "awaiting_approval" })
    .sort({ dueAt: 1 })
    .limit(25)
    .toArray();

  const rows = await Promise.all(
    held.map(async (a) => ({
      action: a,
      person: await db.collection(C.people).findOne({ _id: new ObjectId(String(a.personId)) }),
      goal: await db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(a.goalInstanceId)) }),
    })),
  );

  return (
    <>
      <div className="head">
        <div>
          <h1>Review</h1>
          <p className="sub">
            {held.length === 0
              ? "Messages held for review land here before they go out."
              : `${held.length} waiting. Approving releases a message to the send queue, where every guardrail still applies.`}
          </p>
        </div>
        {held.length > 1 && (
          <form action={decide} className="spacer">
            <input type="hidden" name="productId" value={id} />
            <input type="hidden" name="decision" value="approve" />
            {held.map((a) => (
              <input key={String(a._id)} type="hidden" name="ids" value={String(a._id)} />
            ))}
            <button className="quiet" type="submit">Approve all {held.length}</button>
          </form>
        )}
      </div>

      {held.length === 0 ? (
        <div className="empty">
          <strong>Nothing waiting</strong>
          Goals set to hold each message for review will queue them here.
        </div>
      ) : (
        rows.map(({ action, person, goal }) => {
          const content = action.content as { subject?: string; bodyMd?: string };
          return (
            <div className="card" key={String(action._id)} style={{ marginBottom: 16 }}>
              <div className="head" style={{ marginBottom: 12 }}>
                <div>
                  <strong>{String(person?.name ?? person?.primaryEmail ?? "Unknown")}</strong>{" "}
                  <span className="muted">{String(person?.primaryEmail ?? "")}</span>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {String(goal?.goalKey ?? "—")} · {String(action.channel)} · angle {String(action.angle)}
                  </div>
                </div>
                <span className="spacer" />
                <form action={decide} className="row">
                  <input type="hidden" name="productId" value={id} />
                  <input type="hidden" name="ids" value={String(action._id)} />
                  <button name="decision" value="approve" type="submit" className="sm">Approve</button>
                  <button name="decision" value="reject" type="submit" className="quiet sm">Reject</button>
                </form>
              </div>

              <div className="preview">
                {content.subject && (
                  <div className="preview-head"><span className="k">Subject</span> <strong>{content.subject}</strong></div>
                )}
                <div className="preview-body">{content.bodyMd}</div>
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
