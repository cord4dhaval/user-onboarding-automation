"use client";

import { Fragment, type ReactNode } from "react";
import {
  ArrowLeft,
  BatteryFull,
  Camera,
  EllipsisVertical,
  ExternalLink,
  Info,
  Mic,
  Paperclip,
  Phone,
  Plus,
  Reply,
  Search,
  Signal,
  Smile,
  Video,
  Wifi,
} from "lucide-react";
import { istDay, istTime, istWeekday } from "../../../ui/time";

/**
 * A WhatsApp message as the lead meets it: its line in the chat list, then the chat itself,
 * on WhatsApp Web or on a phone.
 *
 * The email preview answers "how does this land in an inbox"; a WhatsApp message has no
 * subject, no sender address and no HTML, and what decides whether it is read is different —
 * the first line in the chat list, how the *bold* and _italic_ markers turn out, how long
 * the bubble is on a phone, and the buttons under it. Plain text in a grey box showed the
 * asterisks as asterisks, which is not what anyone receives.
 */
export default function WhatsAppPreview({
  businessName,
  text,
  when,
  device,
  footer,
  buttons = [],
}: {
  /** The name the chat is headed with on the lead's phone. */
  businessName: string;
  /** The message body, with WhatsApp's own formatting markers. */
  text: string;
  /** When it lands: the send for a sent message, the due date for one still waiting. */
  when?: string;
  device: "web" | "mobile";
  /** The template's footer line, shown small under the words as WhatsApp does. */
  footer?: string;
  buttons?: { kind: "url" | "reply" | "phone"; text: string }[];
}) {
  const at = when ?? new Date().toISOString();
  const time = istTime(at);
  // The chip over the message is its day, which is "Today" only when it lands today.
  const day = istDay(at) === istDay(new Date()) ? "Today" : istWeekday(at);
  const firstLine = plainLine(text);

  const bubble = (
    <div className="wa-msg">
      <div className="wa-bubble">
        <div className="wa-text">{formatted(text)}</div>
        {footer ? <div className="wa-footer">{footer}</div> : null}
        <span className="wa-time">{time}</span>
      </div>
      {buttons.length ? (
        <div className="wa-buttons">
          {buttons.map((b) => (
            <span key={b.text} className="wa-button">
              {b.kind === "url" ? <ExternalLink size={14} /> : b.kind === "phone" ? <Phone size={14} /> : <Reply size={14} />}
              {b.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );

  // What the chat opens on: the date, and Meta's notice that a business is using its
  // platform, which every business chat carries above the first message.
  const opening = (
    <>
      <span className="wa-chip wa-day">{day}</span>
      <span className="wa-chip wa-notice">
        <Info size={12} /> This business uses a secure service from Meta to manage this chat.
      </span>
      {bubble}
    </>
  );

  if (device === "web") {
    return (
      <div className="wa">
        <div className="wa-web">
          <aside className="wa-list" aria-label="Chats">
            <div className="wa-list-head">
              <strong>Chats</strong>
              <span className="wa-soft" aria-hidden="true">
                <Plus size={17} />
                <EllipsisVertical size={17} />
              </span>
            </div>
            <div className="wa-search">
              <Search size={14} /> Search or start a new chat
            </div>
            <div className="wa-row on">
              <Avatar name={businessName} />
              <div className="wa-row-main">
                <div className="wa-row-top">
                  <strong>{businessName}</strong>
                  <span className="wa-row-time">{time}</span>
                </div>
                <div className="wa-row-bottom">
                  <span className="wa-row-snippet">{firstLine}</span>
                  <span className="wa-unread">1</span>
                </div>
              </div>
            </div>
          </aside>

          <section className="wa-chat" aria-label={`Chat with ${businessName}`}>
            <header className="wa-head">
              <Avatar name={businessName} />
              <div className="wa-head-who">
                <strong>{businessName}</strong>
                <span className="wa-soft">Business account</span>
              </div>
              <span className="wa-soft wa-head-tools" aria-hidden="true">
                <Video size={18} />
                <Search size={17} />
                <EllipsisVertical size={17} />
              </span>
            </header>
            <div className="wa-wall">{opening}</div>
            <footer className="wa-compose" aria-hidden="true">
              <Plus size={20} />
              <Smile size={20} />
              <span className="wa-input">Type a message</span>
              <Mic size={20} />
            </footer>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="wa">
      <div className="phone">
        <div className="phone-screen wa-screen">
          <div className="phone-status">
            <strong>9:41</strong>
            <span aria-hidden="true">
              <Signal size={13} />
              <Wifi size={13} />
              <BatteryFull size={15} />
            </span>
          </div>

          <p className="wa-cap">Chats</p>
          <div className="wa-row">
            <Avatar name={businessName} />
            <div className="wa-row-main">
              <div className="wa-row-top">
                <strong>{businessName}</strong>
                <span className="wa-row-time">{time}</span>
              </div>
              <div className="wa-row-bottom">
                <span className="wa-row-snippet">{firstLine}</span>
                <span className="wa-unread">1</span>
              </div>
            </div>
          </div>

          <p className="wa-cap">Opened</p>
          <div className="wa-m-chat">
            <header className="wa-head wa-m-head">
              <ArrowLeft size={20} aria-hidden="true" />
              <Avatar name={businessName} />
              <div className="wa-head-who">
                <strong>{businessName}</strong>
                <span className="wa-soft">Business account</span>
              </div>
              <span className="wa-soft wa-head-tools" aria-hidden="true">
                <Video size={19} />
                <Phone size={17} />
                <EllipsisVertical size={17} />
              </span>
            </header>
            <div className="wa-wall">{opening}</div>
            <footer className="wa-compose wa-m-compose" aria-hidden="true">
              <span className="wa-input">
                <Smile size={19} /> Message
                <span className="wa-input-tools">
                  <Paperclip size={17} />
                  <Camera size={17} />
                </span>
              </span>
              <span className="wa-mic">
                <Mic size={18} />
              </span>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="wa-avatar" aria-hidden="true">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** The first line of the message as the chat list shows it: markers gone, one line. */
function plainLine(text: string): string {
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  return first.replace(/```/g, "").replace(/(^|\s)[*_~]+|[*_~]+(?=\s|$)/g, "$1").trim();
}

/**
 * WhatsApp's own formatting: *bold*, _italic_, ~strikethrough~ and ```monospace```. A
 * marker counts only where WhatsApp counts it — hugging the words, with no letter on the
 * outside — so a snake_case word or a price like 5*3 stays as typed. Links look like links
 * and are not followed: the opt-out link is real, and a click here would count as theirs.
 */
function formatted(text: string): ReactNode[] {
  const pattern =
    /(https?:\/\/[^\s]+)|```([\s\S]+?)```|(?<![\p{L}\p{N}])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])~(?=\S)([^~\n]*?\S)~(?![\p{L}\p{N}])/gu;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) out.push(<Fragment key={i++}>{text.slice(last, start)}</Fragment>);
    const [whole, url, mono, bold, italic, strike] = m;
    if (url) out.push(<span key={i++} className="wa-link" title={url}>{url}</span>);
    else if (mono !== undefined) out.push(<code key={i++} className="wa-mono">{mono}</code>);
    else if (bold !== undefined) out.push(<strong key={i++}>{formatted(bold)}</strong>);
    else if (italic !== undefined) out.push(<em key={i++}>{formatted(italic)}</em>);
    else if (strike !== undefined) out.push(<s key={i++}>{formatted(strike)}</s>);
    last = start + whole.length;
  }
  if (last < text.length) out.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return out;
}
