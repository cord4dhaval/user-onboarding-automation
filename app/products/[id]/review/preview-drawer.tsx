"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Check, Eye, Pencil, RotateCcw, Sparkles, X } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, Spinner, SubmitButton } from "../../../ui/kit";
import { decide, editMessage, regenerateMessage, rescheduleMessage, returnToReview, type HeldMessage } from "../../../actions";
import { ist, istInputValue } from "../../../ui/time";

/**
 * One held message, previewed as it will actually arrive.
 *
 * The list is a table, so the body lives here rather than inline under every row: a page of
 * 500 rendered emails is megabytes to show six columns of metadata. It is fetched on open
 * and kept, so reopening the same message is free.
 *
 * The format control sits beside Approve because it decides what Approve sends — picking
 * one switches the preview with it, so the reader is always looking at the version they
 * are about to release.
 */
export default function PreviewDrawer({
  productId,
  actionId,
  personName,
  personEmail,
  meta,
  fetchMessage,
}: {
  productId: string;
  actionId: string;
  personName: string;
  personEmail: string;
  meta: string;
  fetchMessage: (actionId: string) => Promise<HeldMessage | null>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<HeldMessage | null>(null);
  const [format, setFormat] = useState<"html" | "text">("html");
  const [pending, start] = useTransition();
  /** Which of the three changes is open. Only one at a time — they all act on this message. */
  const [panel, setPanel] = useState<"none" | "edit" | "schedule" | "rewrite">("none");

  function show() {
    setOpen(true);
    setPanel("none");
    if (message) return;
    start(async () => {
      const loaded = await fetchMessage(actionId);
      setMessage(loaded);
      setFormat(loaded?.canHtml && loaded.bodyHtml ? "html" : "text");
    });
  }

  const designed = Boolean(message?.canHtml && message.bodyHtml);
  // A decision is only on offer while the message is still waiting. Everything else opens
  // read-only: the point of showing it is the record, not a second chance to approve it.
  const waiting = message?.status === "awaiting_approval";
  // A message nobody received is not finished with — whatever stopped it may be gone by
  // now. The way back belongs here, next to the reason it stopped, and not only on the row.
  const recoverable =
    message?.status === "failed" || (message?.status === "skipped" && Boolean(message.skipReason));

  return (
    <>
      <Button variant="quiet" size="sm" icon={<Eye />} loading={pending && !message} onClick={show}>
        Preview
      </Button>

      <Drawer
        open={open}
        title={personName}
        description={`${personEmail} · ${meta}`}
        onClose={() => setOpen(false)}
        width={760}
      >
        {pending && !message ? (
          <p className="muted row"><Spinner /> Loading the message…</p>
        ) : !message ? (
          <div className="empty">
            <strong>Message not found</strong>
            It was deleted while the list was open.
          </div>
        ) : (
          <>
            {/* The format choice belongs with the preview it changes, not with the button
                that acts on it — they used to share one line and read as one control. */}
            <div className="preview-format">
              <div className="row">
                {designed && (
                  <button
                    type="button"
                    className={`pill ${format === "html" ? "accent" : ""}`}
                    onClick={() => setFormat("html")}
                  >
                    Designed email
                  </button>
                )}
                <button
                  type="button"
                  className={`pill ${format === "text" ? "accent" : ""}`}
                  onClick={() => setFormat("text")}
                >
                  Plain text
                </button>
              </div>
              <p className="muted">
                {!waiting
                  ? outcomeLine(message)
                  : designed
                    ? format === "html"
                      ? "Approving sends this designed version."
                      : "Approving sends the text below instead — this message only."
                    : message.canHtml
                      ? "No designed version was rendered for this message."
                      : "This channel sends plain text only."}
              </p>
            </div>

            <div className="preview">
              {message.subject && (
                <div className="preview-head">
                  <span className="k">Subject</span> <strong>{message.subject}</strong>
                </div>
              )}
              {format === "html" && message.bodyHtml ? (
                <iframe
                  title={`Message to ${personEmail}`}
                  srcDoc={message.bodyHtml}
                  className="preview-frame"
                />
              ) : (
                <div className="preview-body">
                  {message.bodyText || message.previewError || "This message has no body."}
                </div>
              )}
            </div>

            {/* A body rendered on open, not read off the action. Saying so is the difference
                between "this is the message" and "this is the message as long as nobody
                edits the template before it goes". */}
            {message.preview && !message.previewError ? (
              <p className="muted preview-why">
                Rendered from the template now — the greeting, button and opt-out line are
                added at send, exactly as shown.
              </p>
            ) : null}

            {message.rationale ? (
              <p className="muted preview-why">Why this: {message.rationale}</p>
            ) : null}

            {/* Changing the message, rather than only deciding on it.
                Three separate things a reviewer wants at this point and could not do at
                all: fix a line, move the date, or ask for it to be written again. They open
                one at a time — all three act on this same message, and two of them open
                would leave it unclear which one Save applies to. */}
            {message.editable && (
              <div className="msg-tools">
                <div className="row">
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<Pencil />}
                    onClick={() => setPanel(panel === "edit" ? "none" : "edit")}
                  >
                    Edit copy
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<CalendarClock />}
                    onClick={() => setPanel(panel === "schedule" ? "none" : "schedule")}
                  >
                    Reschedule
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<Sparkles />}
                    onClick={() => setPanel(panel === "rewrite" ? "none" : "rewrite")}
                  >
                    Rewrite
                  </Button>
                  {message.rewriteRequestedAt ? (
                    <span className="pill">rewrite asked for {ist(message.rewriteRequestedAt)}</span>
                  ) : null}
                </div>

                {panel === "edit" && (
                  <form action={editMessage} className="msg-form">
                    <input type="hidden" name="productId" value={productId} />
                    <input type="hidden" name="actionId" value={actionId} />
                    <label>
                      Subject
                      <input name="subject" defaultValue={message.subject ?? ""} />
                    </label>
                    <label>
                      Message
                      <textarea name="body" rows={10} defaultValue={message.editableBody ?? ""} />
                    </label>
                    {/* Says what the reviewer is not responsible for writing, because the
                        preview above shows those parts and the box below does not. */}
                    <p className="muted">
                      Write the message only — the greeting, the button and the opt-out line
                      are added from the template when it sends.
                    </p>
                    <SubmitButton icon={<Check />} pendingLabel="Saving…">
                      Save copy
                    </SubmitButton>
                  </form>
                )}

                {panel === "schedule" && (
                  <form action={rescheduleMessage} className="msg-form">
                    <input type="hidden" name="productId" value={productId} />
                    <input type="hidden" name="actionId" value={actionId} />
                    <label>
                      Send at (IST)
                      <input type="datetime-local" name="dueAt" defaultValue={istInputValue(message.dueAt)} />
                    </label>
                    <p className="muted">
                      The engine sends on this date under every guardrail. A message that
                      failed or was stopped returns to the queue for the new date.
                    </p>
                    <SubmitButton icon={<CalendarClock />} pendingLabel="Moving…">
                      Save date
                    </SubmitButton>
                  </form>
                )}

                {panel === "rewrite" && (
                  <form action={regenerateMessage} className="msg-form">
                    <input type="hidden" name="productId" value={productId} />
                    <input type="hidden" name="actionId" value={actionId} />
                    <label>
                      What should change? (optional)
                      <textarea
                        name="instruction"
                        rows={3}
                        placeholder="e.g. he clicked the welcome — open on what he looked at, and ask something smaller"
                      />
                    </label>
                    <p className="muted">
                      Clears the copy and puts this person at the front of the writing queue.
                      The next Advance run writes it with their history in front of it; the
                      message comes back here for approval rather than sending itself.
                    </p>
                    <SubmitButton icon={<Sparkles />} pendingLabel="Asking…">
                      Ask for a rewrite
                    </SubmitButton>
                  </form>
                )}
              </div>
            )}

            {/* Sticky, because the decision must stay reachable without scrolling back up
                past a full-height rendered email. */}
            {waiting && (
              <form action={decide} className="drawer-foot">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="ids" value={actionId} />
                <input type="hidden" name="format" value={format} />
                <SubmitButton name="decision" value="approve" icon={<Check />} pendingLabel="Sending…">
                  Approve
                </SubmitButton>
                <SubmitButton name="decision" value="reject" variant="quiet" icon={<X />}>
                  Reject
                </SubmitButton>
              </form>
            )}

            {/* Returned to the queue rather than resent: the thing that stopped it may
                still be in force, so a human looks at it again before it goes out. */}
            {!waiting && recoverable && (
              <form action={returnToReview} className="drawer-foot">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="ids" value={actionId} />
                <SubmitButton variant="quiet" icon={<RotateCcw />} pendingLabel="Returning…">
                  Return to review
                </SubmitButton>
              </form>
            )}
          </>
        )}
      </Drawer>
    </>
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
    case "queued":
      return "Approved and in the send queue.";
    case "failed":
      return message.skipReason
        ? `Never reached anyone — the send errored: ${message.skipReason}`
        : "Never reached anyone — the send errored.";
    case "skipped":
      return message.skipReason
        ? `Never reached anyone — one of our limits stopped it: ${message.skipReason}.`
        : `Rejected ${when(message.reviewedAt)}. Nothing was sent.`;
    default:
      return `Status: ${message.status}.`;
  }
}
