import { ObjectId } from "mongodb";
import { notFound } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { TRIAL_LEADS, ideasLoopOn, ideasOf, inventedOf, type Idea } from "@/engine/ideas.js";
import { evidenceStatus, ideaPerformance } from "@/engine/outcomes.js";
import { requireSession } from "../../../tenant";
import { ActionButton } from "../../../ui/kit";
import { moveInventedIdea, reviewTrialIdeas } from "./actions";

export const dynamic = "force-dynamic";

interface Totals {
  sent: number;
  clicked: number;
  replied: number;
  won: number;
  best: { group: string; sent: number; responses: number } | null;
}

const READ: Record<ReturnType<typeof evidenceStatus>, string> = {
  guess: "too few sends to say",
  promising: "early interest",
  confirmed: "working",
  retire: "nothing back after 10+ sends",
};

/**
 * Every idea the emails are built on, and what each has earned.
 *
 * The approved bank and the ideas Claude invented when none fitted a lead, side by side, so a
 * person can see which scenes earn clicks and replies, and stop an invented one that should
 * not go further. Development only until Dhaval has watched the loop work.
 */
export default async function Ideas({ params }: { params: Promise<{ id: string }> }) {
  if (!ideasLoopOn()) notFound();
  const { id } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [product, rows, planned, plannedEver] = await Promise.all([
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }, { projection: { "config.writing.ideas": 1, "config.writing.invented": 1 } }),
    ideaPerformance(orgId, id),
    plannedLeads(orgId, id, weekAgo),
    plannedLeads(orgId, id, null),
  ]);
  if (!product) notFound();

  const totals = new Map<number, Totals>();
  for (const r of rows) {
    const t = totals.get(r.n) ?? { sent: 0, clicked: 0, replied: 0, won: 0, best: null };
    t.sent += r.sent;
    t.clicked += r.clicked;
    t.replied += r.replied;
    t.won += r.won;
    const responses = r.clicked + r.replied + r.won;
    if (r.sent >= 3 && (!t.best || responses / r.sent > t.best.responses / t.best.sent)) t.best = { group: r.group, sent: r.sent, responses };
    totals.set(r.n, t);
  }

  const bank = ideasOf(product);
  const usable = bank.filter((i) => i.usable !== false);
  const invented = inventedOf(product).sort((a, b) => b.n - a.n);

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Ideas</h1>
          <p className="sub">
            The scenes every email is built on: the approved bank, and ideas Claude writes when none of them fits a
            lead. A new idea starts on trial. It reaches {TRIAL_LEADS} leads, and once those are sent it either stays
            (ranked like the bank) or retires, with the reason on its row. Results feed the ranking on every lead card.
            Running in development only.
          </p>
        </div>
        <div className="row">
          <ActionButton
            variant="quiet"
            icon={<RefreshCw />}
            action={reviewTrialIdeas.bind(null, id)}
            pendingLabel="Reviewing"
            toast={{ title: "Trial ideas reviewed", body: "Any idea that moved shows its reason on its row." }}
          >
            Review trials now
          </ActionButton>
        </div>
      </header>

      <h2>Invented by Claude</h2>
      {invented.length === 0 ? (
        <p className="empty">
          <strong>No invented ideas yet.</strong>
          When no bank idea fits a lead, the planner can write one with propose_idea. It shows up here first.
        </p>
      ) : (
        <div className="tw scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Idea</th>
                <th>Hook</th>
                <th>Status</th>
                <th className="num">Leads</th>
                <th className="num">Sent</th>
                <th className="num">Clicked</th>
                <th className="num">Replied</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invented.map((idea) => {
                const t = totals.get(idea.n);
                return (
                  <tr key={idea.n}>
                    <td className="num">{idea.n}</td>
                    <td>
                      <strong>{idea.title}</strong>
                      <div className="reason">{idea.detail}</div>
                      <div className="reason">Why: {idea.reason}</div>
                      <span className="cell-sub">
                        {idea.plan} · card {idea.card ?? "none"}
                        {idea.fromRefs?.length ? ` · from ${idea.fromRefs.map((n) => `#${n}`).join(", ")}` : ""}
                        {idea.bornFor ? ` · written for a ${idea.bornFor.goalKey.replace(/_/g, " ")} lead` : ""}
                      </span>
                    </td>
                    <td>{idea.hook.replace(/_/g, " ")}</td>
                    <td>
                      <span className={`pill ${idea.status === "active" ? "ok" : idea.status === "retired" ? "bad" : "warm"}`}>{idea.status}</span>
                      {idea.statusReason && <div className="reason">{idea.statusReason}</div>}
                    </td>
                    <td className="num">
                      {plannedEver.get(idea.n) ?? 0}
                      {idea.status === "trial" && <div className="muted">of {TRIAL_LEADS}</div>}
                    </td>
                    <td className="num">{t?.sent ?? 0}</td>
                    <td className="num">{t?.clicked ?? 0}</td>
                    <td className="num">{t?.replied ?? 0}</td>
                    <td>
                      {idea.status === "retired" ? (
                        <ActionButton variant="quiet" action={moveInventedIdea.bind(null, id, idea.n, "trial")} pendingLabel="Restoring">
                          Put back on trial
                        </ActionButton>
                      ) : (
                        <ActionButton variant="quiet" action={moveInventedIdea.bind(null, id, idea.n, "retired")} pendingLabel="Retiring">
                          Retire
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>The approved bank</h2>
      <p className="sub">
        {usable.length} of {bank.length} ideas are usable; the other {bank.length - usable.length} rest on features that are
        not verified yet and never reach a plan. An idea needs 10 sends before its rate says anything; at about 2% clicks,
        most rows will read &ldquo;too few sends&rdquo; for a while.
      </p>
      <div className="tw scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Idea</th>
              <th>Hook</th>
              <th className="num">Leads this week</th>
              <th className="num">Sent</th>
              <th className="num">Clicked</th>
              <th className="num">Replied</th>
              <th className="num">Signed up</th>
              <th>Read</th>
            </tr>
          </thead>
          <tbody>
            {[...usable]
              .sort((a, b) => (totals.get(b.n)?.sent ?? 0) - (totals.get(a.n)?.sent ?? 0) || a.n - b.n)
              .map((idea) => (
                <BankRow key={idea.n} idea={idea} t={totals.get(idea.n)} week={planned.get(idea.n) ?? 0} />
              ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function BankRow({ idea, t, week }: { idea: Idea; t: Totals | undefined; week: number }) {
  return (
    <tr>
      <td className="num">{idea.n}</td>
      <td>
        <strong>{idea.title}</strong>
        {idea.detail && <div className="reason">{idea.detail}</div>}
        <span className="cell-sub">
          {idea.plan ?? "Standard"} · card {idea.card ?? "none"}
          {t?.best && t.best.responses > 0 ? ` · best with ${t.best.group} (${t.best.responses} of ${t.best.sent})` : ""}
        </span>
      </td>
      <td>{idea.hook.replace(/_/g, " ")}</td>
      <td className="num">{week}</td>
      <td className="num">{t?.sent ?? 0}</td>
      <td className="num">{t?.clicked ?? 0}</td>
      <td className="num">{t?.replied ?? 0}</td>
      <td className="num">{t?.won ?? 0}</td>
      <td className="muted">{t && t.sent > 0 ? READ[evidenceStatus(t)] : "not sent yet"}</td>
    </tr>
  );
}

/** Distinct leads whose rolling plans named each idea, since a date or ever. */
async function plannedLeads(orgId: string, productId: string, since: Date | null): Promise<Map<number, number>> {
  const db = await getDb();
  const rows = await db
    .collection(C.plans)
    .aggregate([
      { $match: { orgId, productId, rolling: true, ...(since ? { createdAt: { $gte: since } } : {}) } },
      { $unwind: "$steps" },
      { $unwind: "$steps.idea_refs" },
      { $group: { _id: "$steps.idea_refs", leads: { $addToSet: "$goalInstanceId" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [Number(r._id), (r.leads as unknown[]).length]));
}
