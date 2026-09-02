"use client";

import { useState } from "react";
import { Code, Type } from "lucide-react";

/**
 * Both versions of the message, always. Every email carries an HTML part and a text part,
 * and the text one is what a screen reader, a watch and a stripped-down client actually
 * show — so it is a tab here rather than something you have to go and find.
 *
 * Switching is client-side: a round trip to re-render a preview that is already in hand
 * would put a blank frame between two views of the same message.
 */
export default function PreviewPanel({
  html,
  text,
  subject,
  preheader,
  to,
  sends,
}: {
  html?: string;
  text: string;
  subject?: string;
  preheader?: string;
  to: string;
  /** What actually goes out, which is not always both. */
  sends: "html" | "text";
}) {
  const [tab, setTab] = useState<"html" | "text">(html ? "html" : "text");

  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <div className="seg" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "html"}
            className={tab === "html" ? "on" : undefined}
            onClick={() => setTab("html")}
            disabled={!html}
          >
            <Code size={14} /> HTML
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "text"}
            className={tab === "text" ? "on" : undefined}
            onClick={() => setTab("text")}
          >
            <Type size={14} /> Plain text
          </button>
        </div>
        <span className={`pill ${tab === sends ? "ok" : ""}`}>
          {tab === sends ? "this is what sends" : "carried alongside"}
        </span>
      </div>

      <div className="preview">
        <div className="preview-head">
          <span className="muted">To</span> {to}
        </div>
        {subject && (
          <div className="preview-head">
            <span className="muted">Subject</span> <strong>{subject}</strong>
            {preheader && <div className="muted preheader">{preheader}</div>}
          </div>
        )}
        {tab === "html" && html ? (
          <iframe title="HTML preview" srcDoc={html} className="preview-frame" />
        ) : (
          <div className="preview-body">{text}</div>
        )}
      </div>
    </div>
  );
}
