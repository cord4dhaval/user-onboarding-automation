"use client";

import { Fragment, useState, useTransition, type ReactNode } from "react";
import { CalendarClock, Check, Eye, Monitor, Pencil, RotateCcw, Smartphone, Sparkles, X } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, Spinner, SubmitButton } from "../../../ui/kit";
import {
  decide,
  editMessage,
  regenerateMessage,
  rescheduleMessage,
  returnToReview,
  type HeldMessage,
  type MessageBrief,
} from "../../../actions";
import { ist, istInputValue, istTime, istWeekday } from "../../../ui/time";
import { isReplacedPlan } from "@/engine/replaced.js";
import { digitsOnly } from "@/engine/address.js";
import CopyButton from "../claude/copy-button";
import InboxPreview from "./inbox-preview";
import WhatsAppPreview from "./whatsapp-preview";

/** Where the Fit choice is remembered, per browser. */
const FIT_KEY = "review.preview.fit";

/** The three versions every email can go out as, in the order the tabs show them. */
const FORMATS = [
  { key: "html", label: "Designed" },
  { key: "letter", label: "Letter" },
  { key: "text", label: "Plain text" },
] as const;

/**
 * One held message, previewed as it will actually arrive.
 *
 * The body lives here rather than inline under every row: a page of 500 rendered emails is
 * megabytes to show one line of metadata each. It is fetched on open and kept, so reopening
 * the same message is free.
 *
 * Laid out to the window, not scrolled through. The facts about the message sit in a column
 * beside it, the email is zoomed to fit the space left, and the decision is pinned under
 * both — so the whole message, what it is for, and Approve are on screen at once. It used to
 * be one tall column: header, format pills, tools, an imitation browser, a second subject
 * and sender block, then the message, with Approve somewhere below it.
 */
export default function PreviewDrawer({
  productId,
  actionId,
  personName,
  personEmail,
  from,
  meta,
  facts,
  signal,
  back,
  fetchMessage,
}: {
  productId: string;
  actionId: string;
  personName: string;
  personEmail: string;
  /** The channel's From header, for the inbox preview. */
  from?: string;
  /** One line of context, for callers that do not pass `facts`. */
  meta?: string;
  /** What this message is, as label and value — campaign, angle, sender, when it goes. */
  facts?: { label: string; value: string }[];
  /** What the recipient has already done, rendered by the page. */
  signal?: ReactNode;
  /** The list's filters, so a decision made here returns the reader to the same list. */
  back?: string;
  fetchMessage: (actionId: string) => Promise<HeldMessage | null>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<HeldMessage | null>(null);
  const [format, setFormat] = useState<"html" | "text" | "letter">("html");
  const [device, setDevice] = useState<"web" | "mobile">("web");
  const [fit, setFit] = useState(() => {
    try {
      return localStorage.getItem(FIT_KEY) !== "off";
    } catch {
      return true;
    }
  });
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
      // The writer's choice first, where that version could be rendered; otherwise designed
      // when there is one, as before.
      const chosen = loaded?.chosenFormat;
      setFormat(
        chosen === "text"
          ? "text"
          : chosen === "letter" && loaded?.canHtml && loaded.bodyLetter
            ? "letter"
            : loaded?.canHtml && loaded.bodyHtml
              ? "html"
              : "text",
      );
    });
  }

  function chooseFit(on: boolean) {
    setFit(on);
    try {
      localStorage.setItem(FIT_KEY, on ? "on" : "off");
    } catch {
      // A blocked store only means the choice is not remembered.
    }
  }

  const designed = Boolean(message?.canHtml && message.bodyHtml);
  const letter = Boolean(message?.canHtml && message.bodyLetter);
  // A decision is only on offer while the message is still waiting — at the gate, or dated
  // for later with nobody having decided — the same two the queue lists and `decide` takes.
  // Everything else opens read-only: the point of showing it is the record.
  const waiting =
    message?.status === "awaiting_approval" || (message?.status === "queued" && !message.reviewedAt);
  // A message nobody received is not finished with — whatever stopped it may be gone by
  // now. The way back belongs here, next to the reason it stopped, and not only on the row.
  // A replaced plan's message is the exception: its new step already took its place.
  const recoverable =
    message?.status === "failed" ||
    (message?.status === "skipped" && Boolean(message.skipReason) && !isReplacedPlan(message.skipReason));
  const html = format === "letter" ? message?.bodyLetter : format === "html" ? message?.bodyHtml : undefined;
  const email = message?.channel === "email";
  const whatsapp = message?.channel === "whatsapp" ? message.whatsapp : undefined;
  // A template goes by name with only its variables filled in, so its words are the ones
  // Meta approved: editing or rewriting them here would change the preview and not the send.
  const fixedWords = Boolean(whatsapp?.template);
  // When Approve actually puts it in front of someone, said on the button that does it.
  const dueLater = message?.dueAt ? new Date(message.dueAt).getTime() > Date.now() : false;

  return (
    <>
      <Button variant="quiet" size="sm" icon={<Eye />} loading={pending && !message} onClick={show}>
        Preview
      </Button>

      <Drawer
        open={open}
        title={personName}
        description={message?.to || personEmail || undefined}
        onClose={() => setOpen(false)}
        width={1200}
        bodyClassName="pv-body"
      >
        {pending && !message ? (
          <p className="pv-state muted">
            <Spinner /> Loading the message…
          </p>
        ) : !message ? (
          <div className="pv-state">
            <div className="empty">
              <strong>Message not found</strong>
              It was deleted while the list was open.
            </div>
          </div>
        ) : (
          <div className="pv">
            <aside className="pv-side">
              {/* First, and copyable: the number is what finds this chat in WATI or on the
                  phone, to check what already went to them outside this list. */}
              {message.to ? (
                <section className="pv-sec" aria-label="Their number">
                  <h3 className="pv-h">{whatsapp ? "WhatsApp number" : "Sends to"}</h3>
                  <div className="pv-to">
                    <span className="pv-num">{message.to}</span>
                    <CopyButton text={digitsOnly(message.to) || message.to} label="Copy number" />
                  </div>
                </section>
              ) : null}
              <Brief brief={message.brief} signal={signal} />

              <section className="pv-sec" aria-label="This message">
                <h3 className="pv-h">This message</h3>
              {facts?.length ? (
                <dl className="pv-facts">
                  {facts.map((f) => (
                    <Fragment key={f.label}>
                      <dt>{f.label}</dt>
                      <dd title={f.value}>{f.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : meta ? (
                <p className="pv-meta">{meta}</p>
              ) : null}
              </section>

              {/* Changing the message, rather than only deciding on it: fix a line, move the
                  date, or ask for it to be written again. Beside the message rather than
                  above it, so an edit is made with the email it changes still in view. */}
              {message.editable && (
                <div className="pv-tools">
                  <div className="row">
                    {!fixedWords && (
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<Pencil />}
                      aria-pressed={panel === "edit"}
                      onClick={() => setPanel(panel === "edit" ? "none" : "edit")}
                    >
                      Edit copy
                    </Button>
                    )}
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<CalendarClock />}
                      aria-pressed={panel === "schedule"}
                      onClick={() => setPanel(panel === "schedule" ? "none" : "schedule")}
                    >
                      Reschedule
                    </Button>
                    {!fixedWords && (
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<Sparkles />}
                      aria-pressed={panel === "rewrite"}
                      onClick={() => setPanel(panel === "rewrite" ? "none" : "rewrite")}
                    >
                      Rewrite
                    </Button>
                    )}
                  </div>
                  {fixedWords ? (
                    <p className="muted pv-note">
                      The words are the approved WhatsApp template&rsquo;s. Change them in WATI and
                      submit the new version for approval.
                    </p>
                  ) : null}
                  {message.rewriteRequestedAt ? (
                    <span className="pill">rewrite asked for {ist(message.rewriteRequestedAt)}</span>
                  ) : null}

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
                          preview shows those parts and the box does not. */}
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

            </aside>

            <section className="pv-stage" aria-label="Message">
              <div className="pv-bar">
                {/* The format decides what Approve sends, so switching it switches the
                    preview with it: the reader always sees the version they release. */}
                {designed || letter ? (
                  <div className="seg" role="tablist" aria-label="Format">
                    {FORMATS.filter((f) => (f.key === "html" ? designed : f.key === "letter" ? letter : true)).map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        role="tab"
                        aria-selected={format === f.key}
                        className={format === f.key ? "on" : undefined}
                        onClick={() => setFormat(f.key)}
                        title={message.chosenFormat === f.key ? message.formatWhy || "The writer picked this version" : undefined}
                      >
                        {f.label}
                        {message.chosenFormat === f.key ? <span className="pick">AI pick</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="spacer" />
                {(email || whatsapp) && (
                  <div className="seg" role="tablist" aria-label="Device">
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
                )}
                {/* Fit shrinks the whole message into view; 100% is the size it lands at,
                    for checking small print. */}
                {email && html && device === "web" && (
                  <div className="seg" role="tablist" aria-label="Zoom">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={fit}
                      className={fit ? "on" : undefined}
                      onClick={() => chooseFit(true)}
                    >
                      Fit
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!fit}
                      className={!fit ? "on" : undefined}
                      onClick={() => chooseFit(false)}
                    >
                      100%
                    </button>
                  </div>
                )}
              </div>

              {/* Email and WhatsApp are shown the way the recipient meets them — the line in the
                  inbox or chat list, then opened. Other channels keep the body. */}
              {whatsapp ? (
                <WhatsAppPreview
                  device={device}
                  businessName={whatsapp.businessName}
                  text={message.bodyText || message.previewError || "This message has no body."}
                  when={message.sentAt ?? message.dueAt}
                  footer={whatsapp.footer}
                  buttons={whatsapp.buttons}
                />
              ) : email ? (
                <InboxPreview
                  compact
                  fit={fit}
                  device={device}
                  from={from}
                  subject={message.subject}
                  html={html}
                  text={message.bodyText || message.previewError || "This message has no body."}
                  when={message.sentAt ?? message.dueAt}
                />
              ) : (
                <div className="preview pv-plain">
                  {message.subject && (
                    <div className="preview-head">
                      <span className="k">Subject</span> <strong>{message.subject}</strong>
                    </div>
                  )}
                  {html ? (
                    <iframe title={`Message to ${personEmail}`} srcDoc={html} className="preview-frame" />
                  ) : (
                    <div className="preview-body">
                      {message.bodyText || message.previewError || "This message has no body."}
                    </div>
                  )}
                </div>
              )}
            </section>

            <footer className="pv-foot">
              {waiting ? (
                <form action={decide} className="pv-decide">
                  {back !== undefined && <input type="hidden" name="back" value={back} />}
                  <input type="hidden" name="productId" value={productId} />
                  <input type="hidden" name="ids" value={actionId} />
                  <input type="hidden" name="format" value={format} />
                  <SubmitButton
                    name="decision"
                    value="approve"
                    icon={<Check />}
                    pendingLabel={dueLater ? "Approving…" : "Sending…"}
                  >
                    {dueLater && message.dueAt
                      ? `Approve — sends ${istWeekday(message.dueAt)}, ${istTime(message.dueAt)}`
                      : "Approve — sends now"}
                  </SubmitButton>
                  <SubmitButton name="decision" value="reject" variant="quiet" icon={<X />} pendingLabel="Rejecting…">
                    Reject
                  </SubmitButton>
                </form>
              ) : recoverable ? (
                // Returned to the queue rather than resent: the thing that stopped it may
                // still be in force, so a human looks at it again before it goes out.
                <form action={returnToReview} className="pv-decide">
                  <input type="hidden" name="productId" value={productId} />
                  <input type="hidden" name="ids" value={actionId} />
                  <SubmitButton variant="quiet" icon={<RotateCcw />} pendingLabel="Returning…">
                    Return to review
                  </SubmitButton>
                </form>
              ) : null}
              <p className="pv-says">
                {!waiting
                  ? outcomeLine(message)
                  : whatsapp
                    ? whatsapp.template
                      ? `Approving sends the approved WhatsApp template ${whatsapp.template}, with their name filled in. It can go whether or not they have written to us.`
                      : "Approving sends this as free text. WhatsApp only delivers that within 24 hours of their last message to us."
                  : designed || letter
                    ? format === "html"
                      ? "Approving sends this designed version."
                      : format === "letter"
                        ? "Approving sends this letter version."
                        : "Approving sends the plain text instead — this message only."
                    : message.reply
                      ? "A reply goes as plain text, the words alone — no template around it."
                      : message.canHtml
                        ? "No designed version was rendered for this message."
                        : "This channel sends plain text only."}
                {message.versionsError ? ` The other versions could not be shown: ${message.versionsError}.` : ""}
                {/* A body rendered on open, not read off the action: the words are the ones
                    that go, but a template edit before then would change them. */}
                {waiting && message.preview && !message.previewError
                  ? " Greeting, button and opt-out line are added at send, as shown."
                  : ""}
              </p>
            </footer>
          </div>
        )}
      </Drawer>
    </>
  );
}

/**
 * Who it goes to, why this message, and what it should lead to — in that order, because
 * that is the order a reviewer asks them in. Each part says only what is known: a lead with
 * no form answers shows no form answers, rather than a row of dashes.
 */
function Brief({ brief, signal }: { brief?: MessageBrief; signal?: ReactNode }) {
  if (!brief) return signal ? <div>{signal}</div> : null;
  const { who, why, expect } = brief;
  const day = (iso: string) => istWeekday(iso);

  return (
    <>
      <section className="pv-sec" aria-label="Who they are">
        <h3 className="pv-h">Who they are</h3>
        {who.role ? <p className="pv-lead">{who.role}</p> : null}
        {who.said.length ? (
          <dl className="pv-facts">
            {who.said.map((s) => (
              <Fragment key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.value}</dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
        {who.read ? <p className="pv-read">{who.read}</p> : null}
        {signal}
        <p className="pv-line">
          {[
            who.arrived ? `${who.arrived.how} ${day(who.arrived.at)}` : null,
            who.warmth ? `${who.warmth.band}${who.warmth.score !== undefined ? ` · ${who.warmth.score}` : ""}` : null,
            who.sentBefore === 0
              ? "nothing sent to them yet"
              : `${who.sentBefore} message${who.sentBefore === 1 ? "" : "s"} sent before this`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </section>

      {/* The idea alone, in its own words. A message with no idea from the bank — a
          template step — falls back to the reason it was written. */}
      {why.idea || why.reason ? (
        <section className="pv-sec" aria-label="Why this mail">
          <h3 className="pv-h">Why this mail</h3>
          <p className="pv-idea">{why.idea?.title ?? why.reason}</p>
        </section>
      ) : null}

      {expect.goal || expect.objections.length || expect.next || expect.endsAt ? (
        <section className="pv-sec" aria-label="What we expect">
          <h3 className="pv-h">What we expect</h3>
          {expect.goal ? (
            <p className="pv-goal">
              <span>{expect.goal}</span>
              {expect.goalMet === true ? (
                <span className="pill ok">done</span>
              ) : expect.goalMet === false ? (
                <span className="pill warm">not yet</span>
              ) : null}
            </p>
          ) : null}
          {expect.objections.length ? (
            <div>
              <span className="pv-k">May push back on</span>
              <ul className="pv-list">
                {expect.objections.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {expect.next ? (
            <p className="pv-line">
              <span className="pv-k">Next</span>{" "}
              {expect.next.afterDays !== undefined
                ? `${expect.next.afterDays} day${expect.next.afterDays === 1 ? "" : "s"} later: `
                : ""}
              {expect.next.idea}
              {expect.rolling ? " — may change with how they respond" : ""}
            </p>
          ) : null}
          {expect.endsAt ? (
            <p className="pv-line">
              <span className="pv-k">Campaign ends</span> {day(expect.endsAt)} for them
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/** One line saying what became of a message that is no longer waiting. */
function outcomeLine(message: HeldMessage): string {
  const when = (iso?: string) => (iso ? ist(iso) : "");
  switch (message.status) {
    case "sent":
      // What the provider said afterwards, where it says anything: WhatsApp reports both.
      return message.delivery === "read"
        ? `Sent ${when(message.sentAt)}, and read. This is the message that arrived.`
        : message.delivery === "delivered"
          ? `Sent ${when(message.sentAt)}, and delivered. This is the message that arrived.`
          : `Sent ${when(message.sentAt)}. This is the message that arrived.`;
    case "dispatched":
      return "Handed to the provider — waiting on delivery confirmation.";
    case "sending":
      return "Approved and in the send queue.";
    case "queued":
      // Every message starts queued; only reviewedAt says a person released it.
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
