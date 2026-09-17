"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  BatteryFull,
  ChevronDown,
  EllipsisVertical,
  Monitor,
  Reply,
  Search,
  Signal,
  Smartphone,
  Square,
  Star,
  Trash2,
  Wifi,
} from "lucide-react";
import { istTime, istWeekday } from "../../../ui/time";

/**
 * The message as the recipient meets it: first as one row in a list of other mail, then
 * opened. A rendered body alone answered "is the copy right" and nothing else — not what
 * the sender line reads, how much of the subject survives a phone's width, or which words
 * the inbox shows beside it. Those decide whether the message is opened at all.
 *
 * Web first, because it is the default a reviewer checks against; mobile is one click
 * away rather than a second screen, since most of these are read on a phone.
 */
export default function InboxPreview({
  from,
  subject,
  html,
  text,
  when,
  device: shownDevice,
  compact = false,
  fit = false,
}: {
  /** The channel's From header, `Name <address>` or a bare address. Missing means the provider default. */
  from?: string;
  subject?: string;
  /** The version being approved, when it is HTML. Absent means the plain-text part is what sends. */
  html?: string;
  text: string;
  /** When it lands: the send for a sent message, the due date for one still waiting. */
  when?: string;
  /** Set by a caller that shows its own device switch; the built-in one is hidden then. */
  device?: "web" | "mobile";
  /**
   * The web view without the imitation around it — no browser bar, captions, or second
   * subject and sender block — so the message starts right under its inbox line. For a
   * panel with a fixed height, where that furniture cost half the screen.
   */
  compact?: boolean;
  /** Shrinks a designed message until all of it shows in the space it is given. */
  fit?: boolean;
}) {
  const [ownDevice, setDevice] = useState<"web" | "mobile">("web");
  const device = shownDevice ?? ownDevice;
  const sender = useMemo(() => parseFrom(from), [from]);
  const snippet = useMemo(() => snippetOf(html, text), [html, text]);
  const at = when ?? new Date().toISOString();
  const shownSubject = subject || "(no subject)";

  // The height the message has to fit into, read off its box rather than guessed from the
  // window, so it follows the panel through a resize or an edit form opening above it.
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || !fit) return;
    const observer = new ResizeObserver(([entry]) => setRoom(Math.floor(entry?.contentRect.height ?? 0)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, compact, device]);

  // Each device mounts its own frame, so switching reloads it at the new width and it
  // measures itself again; a new srcDoc does the same when the format changes.
  const body = html ? (
    <MailFrame html={html} title={`Message from ${sender.name}`} fitHeight={compact && fit ? room : undefined} />
  ) : (
    <div className="inbox-text">{linkify(text)}</div>
  );

  const row = (
    <div className="inbox-row">
      <Square size={15} className="inbox-icon" />
      <Star size={15} className="inbox-icon" />
      <strong className="inbox-row-from">{sender.name}</strong>
      <span className="inbox-row-line">
        <strong>{shownSubject}</strong>
        <span className="inbox-soft"> &ndash; {snippet}</span>
      </span>
      <strong className="inbox-row-time">{istTime(at)}</strong>
    </div>
  );

  if (compact && device === "web") {
    return (
      <div className="inbox inbox-compact">
        <div className="inbox-web">
          {row}
          <div className={`inbox-fit ${fit ? "on" : ""}`} ref={box}>
            {body}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="inbox">
      {shownDevice ? null : (
      <div className="preview-bar">
        <div className="seg" role="tablist" aria-label="Inbox preview device">
          <button
            type="button"
            role="tab"
            aria-selected={device === "web"}
            className={device === "web" ? "on" : undefined}
            onClick={() => setDevice("web")}
          >
            <Monitor size={14} /> Web
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={device === "mobile"}
            className={device === "mobile" ? "on" : undefined}
            onClick={() => setDevice("mobile")}
          >
            <Smartphone size={14} /> Mobile
          </button>
        </div>
        <span className="muted inbox-note">As it lands in the recipient&rsquo;s inbox</span>
      </div>
      )}

      {device === "web" ? (
        <div className="inbox-web">
          <div className="inbox-chrome">
            <span className="inbox-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="inbox-search">
              <Search size={14} /> Search mail
            </span>
          </div>

          <p className="inbox-cap">Inbox</p>
          {row}

          <p className="inbox-cap">Opened</p>
          <div className="inbox-open">
            <div className="inbox-subject">
              <h3>{shownSubject}</h3>
              <span className="inbox-chip">Inbox</span>
            </div>
            <div className="inbox-sender">
              <Avatar name={sender.name} />
              <div className="inbox-sender-who">
                <div>
                  <strong>{sender.name}</strong>{" "}
                  {sender.address ? <span className="inbox-soft">&lt;{sender.address}&gt;</span> : null}
                </div>
                <div className="inbox-soft">
                  to me <ChevronDown size={12} />
                </div>
              </div>
              <div className="inbox-sender-side inbox-soft">
                <span>
                  {istWeekday(at)}, {istTime(at)}
                </span>
                <Star size={15} />
                <Reply size={15} />
                <EllipsisVertical size={15} />
              </div>
            </div>
            <div className="inbox-content">{body}</div>
          </div>
        </div>
      ) : (
        <div className="phone">
          <div className="phone-screen">
            <div className="phone-status">
              <strong>9:41</strong>
              <span aria-hidden="true">
                <Signal size={13} />
                <Wifi size={13} />
                <BatteryFull size={15} />
              </span>
            </div>

            <p className="inbox-cap">Inbox</p>
            <div className="m-row">
              <Avatar name={sender.name} />
              <div className="m-row-main">
                <div className="m-row-top">
                  <strong>{sender.name}</strong>
                  <strong className="m-row-time">{istTime(at)}</strong>
                </div>
                <strong className="m-row-subject">{shownSubject}</strong>
                <span className="m-row-snippet">{snippet}</span>
              </div>
            </div>

            <p className="inbox-cap">Opened</p>
            <div className="m-bar" aria-hidden="true">
              <ArrowLeft size={18} />
              <span>
                <Archive size={17} />
                <Trash2 size={17} />
                <EllipsisVertical size={17} />
              </span>
            </div>
            <div className="m-subject">
              <h3>{shownSubject}</h3>
              <span className="inbox-chip">Inbox</span>
            </div>
            <div className="m-sender">
              <Avatar name={sender.name} />
              <div className="inbox-sender-who">
                <div>
                  <strong>{sender.name}</strong> <span className="inbox-soft">{istTime(at)}</span>
                </div>
                <div className="inbox-soft">
                  to me <ChevronDown size={12} />
                </div>
              </div>
              <span className="inbox-soft m-sender-tools" aria-hidden="true">
                <Reply size={17} />
                <EllipsisVertical size={17} />
              </span>
            </div>
            <div className="m-content">{body}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="inbox-avatar" aria-hidden="true">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * How far a message may shrink to fit. Low enough that an ordinary message shows whole on a
 * laptop screen; a longer one scrolls in its box, and Fit off shows it at full size.
 */
const MIN_FIT = 0.55;

/**
 * The rendered email at its natural height. A fixed-height frame puts a second scrollbar
 * inside the drawer's, which no inbox has, and hides how long the message really is.
 *
 * Given a height to fit, the message is zoomed out until all of it shows — down to a floor
 * where the text would stop being legible, past which the box around it scrolls.
 */
function MailFrame({ html, title, fitHeight }: { html: string; title: string; fitHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);

  const size = useCallback(() => {
    const frame = ref.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement) return;
    const root = doc.documentElement;
    root.style.zoom = "";
    const natural = Math.max(root.offsetHeight, doc.body?.scrollHeight ?? 0);
    const scale = fitHeight && natural > fitHeight ? Math.max(MIN_FIT, fitHeight / natural) : 1;
    if (scale < 1) root.style.zoom = String(scale);
    // A measured value, so it is set on the element rather than written as a class.
    frame.style.height = `${Math.ceil(natural * scale)}px`;
  }, [fitHeight]);

  useEffect(() => {
    size();
  }, [size]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={html}
      className="inbox-frame"
      // Same origin so the height can be read; no scripts, and no link is followed — the
      // opt-out and tracked links are real, and a click here would count as the lead's.
      sandbox="allow-same-origin"
      onLoad={(event) => {
        const doc = event.currentTarget.contentDocument;
        doc?.addEventListener("click", (click) => {
          if ((click.target as Element | null)?.closest?.("a")) click.preventDefault();
        });
        size();
      }}
    />
  );
}

/**
 * How the From header reads in a client. With no display name the client shows the
 * mailbox's local part, which is why a bare `hello@` arrives as "hello".
 */
function parseFrom(from?: string): { name: string; address: string } {
  const raw = (from ?? "").trim();
  if (!raw) return { name: "Provider default sender", address: "" };
  const named = raw.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (named) {
    const address = (named[2] ?? "").trim();
    return { name: (named[1] ?? "").trim() || address, address };
  }
  return { name: raw.split("@")[0] || raw, address: raw };
}

/**
 * The words the inbox shows beside the subject: the hidden preheader when the template has
 * one, otherwise the opening of the text part, which is what a client falls back to.
 */
function snippetOf(html: string | undefined, text: string): string {
  if (html && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hidden = doc.body.querySelector("div[style*='display:none']");
    // The preheader is padded with invisible filler so the client stops there; strip it.
    const preheader = hidden?.textContent?.replace(/[ ﻿͏\s]+/g, " ").trim();
    if (preheader) return preheader;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Plain-text mail with its addresses styled as links, the way every client shows it — but
 * not followed. The opt-out address is one of them, and a reviewer clicking it here would
 * unsubscribe the lead they are reviewing.
 */
function linkify(text: string): ReactNode {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <span key={i} className="inbox-link" title={part}>
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
