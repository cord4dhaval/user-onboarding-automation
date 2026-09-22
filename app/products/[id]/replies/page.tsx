import { Suspense } from "react";
import { Check, CheckCheck, ExternalLink, Mail, MessageSquare, X } from "lucide-react";
import { INTENT_LABEL, repliesFor, type ReplyRow, type ReplyState } from "@/engine/replies.js";
import { requireSession } from "../../../tenant";
import { decide, markReplyDone } from "../../../actions";
import { ActionButton, SubmitButton } from "../../../ui/kit";
import { BusyArea, BusyLink, BusyProvider } from "../../../ui/busy";
import { ist, istLong } from "../../../ui/time";
import DecisionToast from "../review/decision-toast";

export const dynamic = "force-dynamic";

/**
 * Every reply on every channel, in one list, sorted by what still needs doing.
 *
 * The tabs are states, not channels: a person answering replies asks "who is waiting on
 * us?", and only then "on which channel?". Automatic replies have a tab of their own, so an
 * out-of-office message never sits among people who actually wrote back.
 */
const VIEWS: Record<"waiting" | "drafted" | "answered" | "closed" | "automatic" | "all", { label: string; empty: string; states: ReplyState[] | null }> = {
  waiting: { label: "Needs an answer", empty: "Nobody is waiting on an answer.", states: ["waiting"] },
  drafted: { label: "Answer drafted", empty: "No drafted answers waiting for approval.", states: ["drafted"] },
  answered: { label: "Answered", empty: "No answered replies yet.", states: ["answered"] },
  closed: { label: "No answer needed", empty: "No replies closed without an answer.", states: ["closed"] },
  automatic: { label: "Automatic", empty: "No out-of-office or automatic replies.", states: ["automatic"] },
  all: { label: "All", empty: "No replies in the last 90 days.", states: null },
};
type ViewKey = keyof typeof VIEWS;
const VIEW_KEYS = Object.keys(VIEWS) as ViewKey[];

const INTENT_TONE: Record<string, string> = {
  interested: "ok",
  call: "ok",
  question: "accent",
  objection: "warm",
  not_now: "",
  later: "",
  no: "bad",
  wrong_person: "",
  unsubscribe: "bad",
};
const STATE_TONE: Record<ReplyState, string> = { waiting: "hot", drafted: "accent", answered: "ok", closed: "", automatic: "" };

export default async function Replies({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; channel?: string }>;
}) {
  const { id } = await params;
  const { view: viewParam, channel: channelParam } = await searchParams;
  const { orgId } = await requireSession();
  const view: ViewKey = VIEW_KEYS.includes(viewParam as ViewKey) ? (viewParam as ViewKey) : "waiting";

  const all = await repliesFor(orgId, id);
  const channels = [...new Set(all.map((r) => r.channel))].sort();
  const channel = channels.includes(String(channelParam)) ? String(channelParam) : undefined;
  const inChannel = channel ? all.filter((r) => r.channel === channel) : all;
  const counts = Object.fromEntries(
    VIEW_KEYS.map((key) => [key, VIEWS[key].states ? inChannel.filter((r) => VIEWS[key].states!.includes(r.state)).length : inChannel.length]),
  ) as Record<ViewKey, number>;
  const rows = VIEWS[view].states ? inChannel.filter((r) => VIEWS[view].states!.includes(r.state)) : inChannel;
  // Oldest first where someone is waiting: the reply that has waited longest comes first.
  if (view === "waiting" || view === "drafted") rows.sort((a, b) => +a.at - +b.at);

  const url = (next: { view?: ViewKey; channel?: string | null }) => {
    const q = new URLSearchParams();
    q.set("view", next.view ?? view);
    const c = next.channel === undefined ? channel : next.channel;
    if (c) q.set("channel", c);
    return `/products/${id}/replies?${q.toString()}`;
  };

  return (
    <BusyProvider>
      <div className="head">
        <div>
          <h1>Replies</h1>
          <p className="sub">
            Every reply by email, WhatsApp and LinkedIn in the last 90 days, with Claude&apos;s reading of it and
            the answer. {counts.waiting + counts.drafted > 0 ? `${counts.waiting + counts.drafted} need you.` : "Nothing needs you."}
          </p>
          <Suspense fallback={null}>
            <DecisionToast />
          </Suspense>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {VIEW_KEYS.map((key) => (
          <BusyLink key={key} href={url({ view: key })} className={key === view ? "on" : undefined} role="tab" aria-selected={key === view}>
            {VIEWS[key].label}
            {counts[key] ? <span className="tab-count">{counts[key]}</span> : null}
          </BusyLink>
        ))}
      </div>

      {channels.length > 1 && (
        <div className="row replies-filter">
          <div className="seg" role="tablist" aria-label="Channel">
            <BusyLink className={!channel ? "on" : ""} href={url({ channel: null })}>
              All channels
            </BusyLink>
            {channels.map((c) => (
              <BusyLink key={c} className={channel === c ? "on" : ""} href={url({ channel: c })}>
                {c}
              </BusyLink>
            ))}
          </div>
        </div>
      )}

      <BusyArea>
        {rows.length === 0 ? (
          <div className="empty">
            <strong>{VIEWS[view].empty}</strong>
            {view === "waiting" && counts.drafted > 0 ? <span>{counts.drafted} drafted answers are waiting for approval.</span> : null}
          </div>
        ) : (
          <div className="reply-list">
            {rows.map((row) => (
              <ReplyCard key={row.id} row={row} productId={id} view={view} channel={channel} />
            ))}
          </div>
        )}
      </BusyArea>
    </BusyProvider>
  );
}

function ReplyCard({ row, productId, view, channel }: { row: ReplyRow; productId: string; view: ViewKey; channel?: string }) {
  const back = new URLSearchParams({ view, ...(channel ? { channel } : {}) }).toString();
  const answer = row.answer;
  const decidable = row.state === "drafted" && answer;
  return (
    <article className={`reply-card ${row.state}`}>
      <div className="reply-top">
        <div className="reply-who">
          <a href={`/products/${productId}/library/${row.personId}`}>
            <strong>{row.name}</strong>
          </a>
          {row.company ? <span className="muted"> · {row.company}</span> : null}
        </div>
        <span className="pill">
          {row.channel === "email" ? <Mail /> : <MessageSquare />} {row.channel}
        </span>
        {row.intent ? <span className={`pill ${INTENT_TONE[row.intent] ?? ""}`}>{INTENT_LABEL[row.intent] ?? row.intent}</span> : null}
        <span className={`pill ${STATE_TONE[row.state]}`}>{row.label}</span>
        <span className="reply-when muted" title={istLong(row.at)}>
          {ist(row.at)}
        </span>
      </div>

      {row.subject ? <div className="muted reply-subject">Subject: “{row.subject}”</div> : null}
      {row.text ? (
        <blockquote className="reply-quote">{row.text.slice(0, 1500)}</blockquote>
      ) : (
        <div className="muted reply-subject">No text in the message.</div>
      )}

      {answer && answer.text ? (
        <div className="reply-answer">
          <div className="reply-answer-head">
            {row.state === "drafted" ? "Answer drafted by Claude" : "Our answer"}
            {answer.sentAt ? <span className="muted"> · sent {ist(answer.sentAt)}</span> : null}
          </div>
          <blockquote className="reply-quote ours">{answer.text.slice(0, 1500)}</blockquote>
        </div>
      ) : null}

      <div className="reply-foot">
        <span className="muted reply-detail">
          {row.detail}
          {row.state === "automatic" && row.holdUntil ? `; resumes ${ist(row.holdUntil)}` : ""}
        </span>
        <span className="spacer" />
        {decidable ? (
          <form action={decide} className="row-actions">
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="ids" value={answer.id} />
            <input type="hidden" name="returnTo" value="replies" />
            <input type="hidden" name="back" value={back} />
            <SubmitButton name="decision" value="approve" size="sm" icon={<Check />} pendingLabel="Approving…">
              Approve answer
            </SubmitButton>
            <SubmitButton name="decision" value="reject" variant="quiet" size="sm" icon={<X />} pendingLabel="Rejecting…">
              Reject
            </SubmitButton>
            <a className="btn quiet sm" href={`/products/${productId}/review?q=${encodeURIComponent(row.email ?? row.name)}`}>
              <ExternalLink size={14} /> Edit in Review
            </a>
          </form>
        ) : null}
        {row.state === "waiting" ? (
          <ActionButton
            size="sm"
            variant="quiet"
            icon={<CheckCheck />}
            action={markReplyDone.bind(null, productId, row.id)}
            pendingLabel="Marking…"
            toast={{ title: "Marked done", body: `${row.name}'s reply is off the waiting list.` }}
          >
            Mark done
          </ActionButton>
        ) : null}
        <a className="btn quiet sm" href={`/products/${productId}/library/${row.personId}`}>
          Open lead
        </a>
      </div>
    </article>
  );
}
