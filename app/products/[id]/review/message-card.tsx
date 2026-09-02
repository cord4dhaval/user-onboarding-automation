"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";
import { decide } from "../../../actions";

export interface MessageCardProps {
  productId: string;
  actionId: string;
  personName: string;
  personEmail: string;
  meta: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  rationale?: string;
  /** False when the channel cannot carry HTML, so the designed version is not on offer. */
  canHtml: boolean;
}

/**
 * One held message, previewed as it will actually arrive.
 *
 * The format control used to sit beside Approve while the card showed the text body
 * underneath it — so "Designed email" was selected above a plain-text preview, and the
 * reader had no way to see the version they were approving. Choosing a format now
 * switches the preview with it.
 */
export default function MessageCard({
  productId,
  actionId,
  personName,
  personEmail,
  meta,
  subject,
  bodyHtml,
  bodyText,
  rationale,
  canHtml,
}: MessageCardProps) {
  const designed = canHtml && Boolean(bodyHtml);
  const [format, setFormat] = useState<"html" | "text">(designed ? "html" : "text");

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="head" style={{ marginBottom: 12 }}>
        <div>
          <strong>{personName}</strong> <span className="muted">{personEmail}</span>
          <div className="muted" style={{ fontSize: 13 }}>{meta}</div>
        </div>
        <span className="spacer" />
        <form action={decide} className="row">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="ids" value={actionId} />
          <input type="hidden" name="format" value={format} />
          <SubmitButton name="decision" value="approve" size="sm" icon={<Check />} pendingLabel="Sending…">
            Approve
          </SubmitButton>
          <SubmitButton name="decision" value="reject" variant="quiet" size="sm" icon={<X />}>
            Reject
          </SubmitButton>
        </form>
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
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
        <span className="muted" style={{ fontSize: 12.5 }}>
          {designed
            ? format === "html"
              ? "Approving sends this designed version."
              : "Approving sends the text below instead — this message only."
            : canHtml
              ? "No designed version was rendered for this message."
              : "This channel sends plain text only."}
        </span>
      </div>

      <div className="preview">
        {subject && (
          <div className="preview-head"><span className="k">Subject</span> <strong>{subject}</strong></div>
        )}
        {format === "html" && bodyHtml ? (
          <iframe title={`Message to ${personEmail}`} srcDoc={bodyHtml} className="preview-frame" />
        ) : (
          <div className="preview-body">{bodyText}</div>
        )}
      </div>

      {rationale ? (
        <p className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>Why this: {rationale}</p>
      ) : null}
    </div>
  );
}
