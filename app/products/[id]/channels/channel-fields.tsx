"use client";

import { useState } from "react";

export interface ToolArg {
  name: string;
  required: boolean;
  type?: string;
  description?: string;
}

export interface ToolChoice {
  /** `connectionId::toolName` — the pair is what the server action needs. */
  value: string;
  label: string;
  description?: string;
  args: ToolArg[];
}

/** A first guess only — every field stays editable, and nothing is filtered out. */
export function guessRef(argName: string): string {
  const n = argName.toLowerCase();
  if (/^(to|recipient|email|to_email|address)$/.test(n)) return "$person.email";
  if (/subject|title/.test(n)) return "$content.subject";
  if (/html/.test(n)) return "$content.bodyHtml";
  if (/^(text|body|message|content)$/.test(n)) return "$content.body";
  if (/^from/.test(n)) return "$channel.from";
  if (/replyto|reply_to/.test(n)) return "$channel.replyTo";
  return "";
}

/**
 * Which tool sends, and what to pass it.
 *
 * Shared by the add and edit drawers rather than written twice: the mapping is the part of
 * a channel most likely to be wrong, and a channel whose send tool could only be chosen at
 * creation had to be deleted and rebuilt — losing its limits and its history — to correct
 * a single argument.
 */
export function SendToolFields({
  choices,
  defaultValue,
  currentArgs,
  defaultReturnPath,
}: {
  choices: ToolChoice[];
  defaultValue?: string;
  /** What this channel passes today, so an edit starts from the truth, not from a guess. */
  currentArgs?: Record<string, string>;
  defaultReturnPath?: string;
}) {
  const [picked, setPicked] = useState(defaultValue ?? choices[0]?.value ?? "");
  const selected = choices.find((c) => c.value === picked);
  // Switching to a different tool has to fall back to guesses: the arguments it takes are
  // not the arguments the old one took.
  const sameTool = picked === defaultValue;

  return (
    <>
      <label>
        Which tool sends the message
        <select name="sendTool" value={picked} onChange={(e) => setPicked(e.target.value)}>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 13 }}>
          {selected?.description
            ? selected.description.slice(0, 180)
            : "Every tool on every connected server. Pick the one that actually sends."}
        </span>
      </label>

      {selected && selected.args.length > 0 && (
        <>
          <p className="sub" style={{ margin: 0 }}>
            What to pass it. Values starting with <code>$</code> are filled in per person; anything else is
            sent as written. Optional fields can be left blank; the ones this tool marks required have to be
            mapped, or it will refuse every message.
          </p>
          {selected.args.map((arg) => (
            <label key={`${picked}:${arg.name}`}>
              <span>
                Argument <code>{arg.name}</code>{" "}
                <span className="muted">
                  {arg.required ? "required" : "optional"}
                  {arg.type ? ` · ${arg.type}` : ""}
                </span>
              </span>
              <input
                name={`arg:${arg.name}`}
                defaultValue={(sameTool ? currentArgs?.[arg.name] : undefined) ?? guessRef(arg.name)}
                placeholder="$person.email"
                required={arg.required}
              />
              {arg.description ? <span className="muted">{arg.description.slice(0, 140)}</span> : null}
            </label>
          ))}
          <label>
            Where their message id lives <span className="muted">(optional)</span>
            <input name="returnMessageId" defaultValue={defaultReturnPath ?? ""} placeholder="$.batchId" />
          </label>
        </>
      )}
    </>
  );
}

/**
 * Designed email or plain text.
 *
 * This lived only as a toggle on the channels table, which meant a new channel sent
 * whatever capability discovery had guessed until someone noticed. It is a decision about
 * every message the channel will ever send, so it is asked at creation and stays editable.
 */
export function FormatChoice({ current = "html" }: { current?: "html" | "text" }) {
  const [format, setFormat] = useState<"html" | "text">(current);
  return (
    <label>
      <span>What this channel sends</span>
      <select name="format" value={format} onChange={(e) => setFormat(e.target.value as "html" | "text")}>
        <option value="html">Designed email — brand colours, buttons, layout</option>
        <option value="text">Plain text — no HTML part at all</option>
      </select>
      <span className="muted" style={{ fontSize: 13 }}>
        {format === "html"
          ? "Only choose this where the provider actually accepts an HTML body."
          : "Plain text reaches inboxes that strip HTML, and reads as a personal message."}
      </span>
    </label>
  );
}
