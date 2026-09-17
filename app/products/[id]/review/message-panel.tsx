"use client";

import { useEffect, useState } from "react";
import {
  AtSign,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Megaphone,
  Monitor,
  Pencil,
  RefreshCw,
  RotateCcw,
  Scan,
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { Button, Spinner, SubmitButton } from "../../../ui/kit";
import {
  decide,
  editMessage,
  regenerateMessage,
  rescheduleMessage,
  returnToReview,
  type HeldMessage,
} from "../../../actions";
import { ist, istInputValue } from "../../../ui/time";
import { isReplacedPlan } from "@/engine/replaced.js";
import InboxPreview from "./inbox-preview";
import { Avatar, Engagement, type QueueRow } from "./queue-row";

type Format = "html" | "text" | "letter";

const FIT_KEY = "review.preview.fit";

/** The writer's choice first, where that version could be rendered; otherwise designed when there is one. */
function initialFormat(message: HeldMessage): Format {
  const chosen = message.chosenFormat;
  if (chosen === "text") return "text";
  if (chosen === "letter" && message.canHtml && message.bodyLetter) return "letter";
  return message.canHtml && message.bodyHtml ? "html" : "text";
}

/**
 * The selected message, read and decided in place.
 *
 * This used to be a drawer opened from the far end of a seven-column table, so reading one
 * message meant scrolling sideways to find its button and closing a panel to reach the
 * next. It sits beside the list now: the header comes from the row, so it is there the
 * instant a row is picked, the body loads under it, and Approve stays pinned to the bottom
 * however tall the rendered email is.
 */
export default function MessagePanel({
  productId,
  row,
  message,
  failed,
  back,
  position,
  onPrev,
  onNext,
  onClose,
  onChanged,
}: {
  productId: string;
  row: QueueRow;
  /** Undefined while it loads; null when it was deleted under the list. */
  message: HeldMessage | null | undefined;
  failed?: string;
  back: string;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  /** Narrow screens only, where the panel covers the list. */
  onClose: () => void;
  /** An edit landed, so the message on screen is stale. */
  onChanged: () => void;
}) {
  const [format, setFormat] = useState<Format>("html");
  /** Which of the three changes is open. Only one at a time — they all act on this message. */
  const [panel, setPanel] = useState<"none" | "edit" | "schedule" | "rewrite">("none");
  const [device, setDevice] = useState<"web" | "mobile">("web");
  const [why, setWhy] = useState(false);
  const [fit, setFit] = useState(true);

  // Whether to shrink an email to fit is a habit of the reader's, so it is remembered in
  // this browser. Read after mount: the server cannot know it, and guessing would not hydrate.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(FIT_KEY) === "actual") setFit(false);
    } catch {
      // Storage refused — fitting is the default anyway.
    }
  }, []);
  function chooseFit(next: boolean) {
    setFit(next);
    try {
      window.localStorage.setItem(FIT_KEY, next ? "fit" : "actual");
    } catch {
      // Not remembered this time; the choice still applies now.
    }
  }

  useEffect(() => {
    if (message) setFormat(initialFormat(message));
  }, [message]);

  const designed = Boolean(message?.canHtml && message.bodyHtml);
  const letter = Boolean(message?.canHtml && message.bodyLetter);
  // Undecided covers both halves of the queue — at the gate, and dated for later with no
  // decision yet — because the list offers the same decision on both.
  const waiting =
    message?.status === "awaiting_approval" || (message?.status === "queued" && !message.reviewedAt);
  // A replaced plan's message stays put: its new step already took its place.
  const recoverable =
    message?.status === "failed" ||
    (message?.status === "skipped" && Boolean(message.skipReason) && !isReplacedPlan(message.skipReason));

  /** Runs a change, then asks for the message again so the preview shows what was saved. */
  const after = (action: (formData: FormData) => Promise<void>) => async (formData: FormData) => {
    await action(formData);
    setPanel("none");
    onChanged();
  };

  const formatNote = !waiting
    ? undefined
    : format === "html"
      ? "Approving sends this designed version."
      : format === "letter"
        ? "Approving sends this letter: HTML that looks typed, with no logo, box or button."
        : "Approving sends the plain text instead — this message only.";

  return (
    <section className="rq-pane" aria-label={`Message to ${row.name}`}>
      <header className="rq-pane-head">
        <Button variant="quiet" size="sm" icon={<ChevronLeft />} className="rq-back" onClick={onClose}>
          Back
        </Button>
        <Avatar name={row.name} hot={row.lifted} />
        <div className="rq-who">
          <div className="rq-who-line">
            <h2>{row.name}</h2>
            <span className="muted">{row.email}</span>
          </div>
          {/* Everything a reviewer weighs before reading a word, on one line. */}
          <div className="rq-facts">
            {row.decidable ? (
              <span className={`rq-fact ${row.dueNow ? "due" : ""}`} title={row.whenLong}>
                <CalendarClock /> {row.dueNow ? "Due now" : `Sends ${row.whenShort}`}
              </span>
            ) : (
              <span className="rq-fact">
                <span className={`pill ${row.state.tone}`}>{row.state.label}</span>
                {row.state.origin ? <span className="pill">{row.state.origin}</span> : null}
                <span title={row.whenLong}>{row.whenShort}</span>
              </span>
            )}
            <Engagement row={row} />
            <span className="rq-fact" title={row.angle ? `angle ${row.angle}` : undefined}>
              <Megaphone /> {row.campaign}
            </span>
            <span className="rq-fact rq-fact-clip" title={row.sender}>
              <AtSign /> {row.sender}
            </span>
          </div>
        </div>
        <div className="rq-step">
          <span className="num">{position}</span>
          <Button variant="quiet" size="sm" icon={<ChevronUp />} onClick={onPrev} disabled={!onPrev} aria-label="Previous message" />
          <Button variant="quiet" size="sm" icon={<ChevronDown />} onClick={onNext} disabled={!onNext} aria-label="Next message" />
        </div>
      </header>

      {/* The message gets the height. Everything that used to stack above it — the format
          switch, the tools, the notes, a browser bar, a second subject and sender — cost
          more than half the panel, so the controls moved to the bar at the bottom and the
          preview starts at its inbox line. */}
      <div className="rq-pane-body">
        {!row.decidable && row.state.detail ? <p className="rq-reason">{row.state.detail}</p> : null}
        {message && !waiting ? <p className="rq-line">{outcomeLine(message)}</p> : null}

        {failed ? (
          <div className="empty">
            <strong>This message could not be loaded</strong>
            {failed}
          </div>
        ) : message === undefined ? (
          <div className="rq-loading" role="status">
            <Spinner size={18} /> Loading the message…
          </div>
        ) : message === null ? (
          <div className="empty">
            <strong>Message not found</strong>
            It was deleted while the list was open.
          </div>
        ) : (
          <>
            {why && (message.rationale || message.theme || message.chosenFormat) ? (
              <div className="rq-why">
                {message.rationale ? <p>{message.rationale}</p> : null}
                {message.theme ? <p><strong>Idea:</strong> {message.theme}</p> : null}
                {message.chosenFormat ? (
                  <p>
                    <strong>Format:</strong>{" "}
                    {message.chosenFormat === "text" ? "plain text" : message.chosenFormat === "letter" ? "letter" : "designed email"}
                    {message.formatWhy ? ` — ${message.formatWhy}` : ""}
                  </p>
                ) : null}
              </div>
            ) : null}
            {message.rewriteRequestedAt ? (
              <p className="rq-line">Rewrite asked for {ist(message.rewriteRequestedAt)}.</p>
            ) : null}

            {panel === "edit" && (
              <form action={after(editMessage)} className="msg-form rq-form">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="actionId" value={row.id} />
                <label>
                  Subject
                  <input name="subject" defaultValue={message.subject ?? ""} />
                </label>
                <label>
                  Message
                  <textarea name="body" rows={10} defaultValue={message.editableBody ?? ""} />
                </label>
                <p className="muted">
                  Write the message only — the greeting, the button and the opt-out line are added
                  from the template when it sends.
                </p>
                <div className="row">
                  <SubmitButton size="sm" icon={<Check />} pendingLabel="Saving…">
                    Save copy
                  </SubmitButton>
                  <Button variant="quiet" size="sm" onClick={() => setPanel("none")}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {panel === "schedule" && (
              <form action={after(rescheduleMessage)} className="msg-form rq-form">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="actionId" value={row.id} />
                <label>
                  Send at (IST)
                  <input type="datetime-local" name="dueAt" defaultValue={istInputValue(message.dueAt)} />
                </label>
                <p className="muted">
                  The engine sends on this date under every guardrail. A message that failed or was
                  stopped returns to the queue for the new date.
                </p>
                <div className="row">
                  <SubmitButton size="sm" icon={<CalendarClock />} pendingLabel="Moving…">
                    Save date
                  </SubmitButton>
                  <Button variant="quiet" size="sm" onClick={() => setPanel("none")}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {panel === "rewrite" && (
              <form action={after(regenerateMessage)} className="msg-form rq-form">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="actionId" value={row.id} />
                <label>
                  What should change? (optional)
                  <textarea
                    name="instruction"
                    rows={3}
                    placeholder="e.g. they clicked the welcome — open on what they looked at, and ask something smaller"
                  />
                </label>
                <p className="muted">
                  Clears the copy and puts this person at the front of the writing queue. The next
                  Advance run writes it with their history in front of it; the message comes back here
                  for approval rather than sending itself.
                </p>
                <div className="row">
                  <SubmitButton size="sm" icon={<Sparkles />} pendingLabel="Asking…">
                    Ask for a rewrite
                  </SubmitButton>
                  <Button variant="quiet" size="sm" onClick={() => setPanel("none")}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            <div className={`rq-preview ${device === "web" && message.channel === "email" ? "fill" : ""}`}>
              {message.channel === "email" ? (
                <InboxPreview
                  from={row.from}
                  subject={message.subject}
                  html={format === "letter" ? message.bodyLetter : format === "html" ? message.bodyHtml : undefined}
                  text={message.bodyText || message.previewError || "This message has no body."}
                  when={message.sentAt ?? message.dueAt}
                  device={device}
                  compact
                  fit={fit}
                />
              ) : (
                <div className="preview">
                  {message.subject && (
                    <div className="preview-head">
                      <span className="k">Subject</span> <strong>{message.subject}</strong>
                    </div>
                  )}
                  {(format === "html" && message.bodyHtml) || (format === "letter" && message.bodyLetter) ? (
                    <iframe
                      title={`Message to ${row.email}`}
                      srcDoc={format === "letter" ? message.bodyLetter : message.bodyHtml}
                      className="preview-frame"
                    />
                  ) : (
                    <div className="preview-body">
                      {message.bodyText || message.previewError || "This message has no body."}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* One bar for everything that acts on the message: the decision first, then how it is
          shown, then what can be changed. Pinned, so none of it is ever below a tall email. */}
      <footer className="rq-pane-foot">
        {/* The decision only appears once the message itself has loaded: a shortcut pressed
            while the next one is still arriving must not decide on something nobody has seen. */}
        {message && waiting ? (
          <form action={decide} className="rq-decide">
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="ids" value={row.id} />
            <input type="hidden" name="format" value={format} />
            <input type="hidden" name="back" value={back} />
            <SubmitButton name="decision" value="approve" icon={<Check />} pendingLabel="Approving…" data-decision="approve">
              Approve <kbd>A</kbd>
            </SubmitButton>
            <SubmitButton name="decision" value="reject" variant="quiet" icon={<X />} pendingLabel="Rejecting…" data-decision="reject">
              Reject <kbd>R</kbd>
            </SubmitButton>
          </form>
        ) : message && recoverable ? (
          // Back to review rather than resent: whatever stopped it may still be in force.
          <form action={returnToReview} className="rq-decide">
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="ids" value={row.id} />
            <SubmitButton variant="quiet" icon={<RotateCcw />} pendingLabel="Returning…">
              Return to review
            </SubmitButton>
          </form>
        ) : null}

        <span className="spacer" />

        {message ? (
          <div className="rq-controls">
            {/* The format decides what Approve sends, so switching it switches the preview. */}
            {designed || letter ? (
              <div className="seg" role="tablist" aria-label="Format" title={formatNote}>
                {designed && (
                  <button type="button" className={format === "html" ? "on" : undefined} onClick={() => setFormat("html")}>
                    Designed
                  </button>
                )}
                {letter && (
                  <button type="button" className={format === "letter" ? "on" : undefined} onClick={() => setFormat("letter")}>
                    Letter
                  </button>
                )}
                <button type="button" className={format === "text" ? "on" : undefined} onClick={() => setFormat("text")}>
                  Plain
                </button>
              </div>
            ) : null}

            {message.channel === "email" ? (
              <div className="seg" role="tablist" aria-label="Preview">
                <button type="button" className={device === "web" ? "on" : undefined} onClick={() => setDevice("web")} title="As it lands on a computer" aria-label="Web">
                  <Monitor />
                </button>
                <button type="button" className={device === "mobile" ? "on" : undefined} onClick={() => setDevice("mobile")} title="As it lands on a phone" aria-label="Mobile">
                  <Smartphone />
                </button>
                {device === "web" ? (
                  <button
                    type="button"
                    className={fit ? "on" : undefined}
                    onClick={() => chooseFit(!fit)}
                    title={fit ? "Showing the whole email — click for actual size" : "Actual size — click to fit the whole email"}
                    aria-pressed={fit}
                  >
                    <Scan /> Fit
                  </button>
                ) : null}
              </div>
            ) : null}

            <span className="rq-divider" aria-hidden="true" />

            {message.rationale || message.theme || message.chosenFormat ? (
              <Button
                variant={why ? "ghost" : "quiet"}
                size="sm"
                icon={<Sparkles />}
                onClick={() => setWhy(!why)}
                aria-pressed={why}
                title="Why Claude wrote this"
              >
                Why
              </Button>
            ) : null}
            {message.editable ? (
              <>
                <Button
                  variant={panel === "edit" ? "ghost" : "quiet"}
                  size="sm"
                  icon={<Pencil />}
                  onClick={() => setPanel(panel === "edit" ? "none" : "edit")}
                  aria-label="Edit copy"
                  title="Edit copy"
                />
                <Button
                  variant={panel === "schedule" ? "ghost" : "quiet"}
                  size="sm"
                  icon={<CalendarClock />}
                  onClick={() => setPanel(panel === "schedule" ? "none" : "schedule")}
                  aria-label="Reschedule"
                  title="Reschedule"
                />
                <Button
                  variant={panel === "rewrite" ? "ghost" : "quiet"}
                  size="sm"
                  icon={<RefreshCw />}
                  onClick={() => setPanel(panel === "rewrite" ? "none" : "rewrite")}
                  aria-label="Ask Claude for a rewrite"
                  title="Ask Claude for a rewrite"
                />
              </>
            ) : null}
          </div>
        ) : null}
      </footer>
    </section>
  );
}

/** One line saying what became of a message that is no longer waiting. */
function outcomeLine(message: HeldMessage): string {
  const when = (iso?: string) => (iso ? ist(iso) : "");
  switch (message.status) {
    case "sent":
      return `Sent ${when(message.sentAt)}. This is the message that arrived.`;
    case "dispatched":
      return "Handed to the provider — waiting on delivery confirmation.";
    case "sending":
      return "Approved and in the send queue.";
    case "queued":
      if (!message.reviewedAt) return "Not approved yet. It waits for your review before it sends.";
      if (message.dueAt && new Date(message.dueAt) > new Date()) {
        const why = message.waitReason ? ` — ${message.waitReason}` : "";
        return `Approved. It sends ${ist(message.dueAt)}${why}.`;
      }
      return "Approved and in the send queue.";
    case "failed":
      return message.skipReason
        ? `Never reached anyone — the send errored: ${message.skipReason}`
        : "Never reached anyone — the send errored.";
    case "skipped":
      if (isReplacedPlan(message.skipReason)) {
        return "Replaced before it was due. The lead's new plan sends its own message in its place.";
      }
      return message.skipReason
        ? `Never reached anyone — one of our limits stopped it: ${message.skipReason}.`
        : `Rejected ${when(message.reviewedAt)}. Nothing was sent.`;
    default:
      return `Status: ${message.status}.`;
  }
}
