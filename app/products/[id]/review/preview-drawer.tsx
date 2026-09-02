"use client";

import { useState, useTransition } from "react";
import { Check, Eye, X } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, Spinner, SubmitButton } from "../../../ui/kit";
import { decide, type HeldMessage } from "../../../actions";
import { ist } from "../../../ui/time";

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

  function show() {
    setOpen(true);
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
                <div className="preview-body">{message.bodyText}</div>
              )}
            </div>

            {message.rationale ? (
              <p className="muted preview-why">Why this: {message.rationale}</p>
            ) : null}

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
      return message.skipReason ? `Failed: ${message.skipReason}` : "Failed on send.";
    case "skipped":
      return message.skipReason
        ? `Approved but never sent — ${message.skipReason}.`
        : `Rejected ${when(message.reviewedAt)}. Nothing was sent.`;
    default:
      return `Status: ${message.status}.`;
  }
}
