import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { requireSession, scope } from "../../../tenant";
import { decide } from "../../../actions";
import { CheckCheck } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";
import MessageCard from "./message-card";

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
      // Whether the designed version is even an option is the channel's business, not
      // the template's, so the card is told rather than left to guess.
      channel: a.channelId
        ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(a.channelId)) })
        : null,
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
        rows.map(({ action, person, run, channel }) => {
          const content = (action.content ?? {}) as { subject?: string; bodyMd?: string; bodyHtml?: string };
          const caps = (channel?.capabilities ?? {}) as { html?: boolean };
          return (
            <MessageCard
              key={String(action._id)}
              productId={id}
              actionId={String(action._id)}
              personName={String(person?.name ?? person?.primaryEmail ?? "Unknown")}
              personEmail={String(person?.primaryEmail ?? "")}
              meta={`${String(run?.goalKey ?? "—")} · ${String(action.channel)} · angle ${String(action.angle)}`}
              subject={content.subject}
              bodyHtml={content.bodyHtml}
              bodyText={content.bodyMd}
              rationale={action.rationale ? String(action.rationale) : undefined}
              canHtml={caps.html !== false}
            />
          );
        })
      )}
    </>
  );
}
