"use client";

import { useState, useTransition } from "react";
import { Check, Eye, X } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, Spinner, SubmitButton } from "../../../ui/kit";
import { decide, type HeldMessage } from "../../../actions";

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
            <strong>Already reviewed</strong>
            This message left the queue while the list was open.
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
                {designed
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
          </>
        )}
      </Drawer>
    </>
  );
}
