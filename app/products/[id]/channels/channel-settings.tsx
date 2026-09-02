"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import { FormatChoice, SendToolFields, type ToolChoice } from "./channel-fields";
import { WINDOW_LABEL, windowTime, type UsageWindow } from "./windows";

export interface ChannelSettings {
  id: string;
  key: string;
  kind: string;
  from?: string;
  replyTo?: string;
  status: string;
  html: boolean;
  dailyCap: number;
  perMinute?: number;
  perHour?: number;
  maxSubjectLength?: number;
  maxBodyLength?: number;
  /** `connectionId::toolName`, when this channel sends through an MCP tool. */
  sendTool?: string;
  /** What that tool is passed today, so the mapping opens showing the truth. */
  sendArgs?: Record<string, string>;
  returnMessageId?: string;
  /** Which connection it goes through, named so a rebind is not a silent move. */
  through?: string;
}

/**
 * Editing a live channel.
 *
 * Every one of these was create-only: a daily cap left at the form's default of 50 could
 * only be changed by writing to the database, and it is the number that decides how much
 * of an approved batch actually leaves. The current spend sits above the field for the
 * same reason — a cap is only meaningful next to what has already been spent against it.
 */
export default function ChannelSettingsDrawer({
  channel,
  usage,
  toolChoices,
  action,
}: {
  channel: ChannelSettings;
  usage: UsageWindow[];
  /** Every tool on every connected server, so the sender can be corrected or moved. */
  toolChoices: ToolChoice[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="quiet" size="sm" icon={<Pencil />} onClick={() => setOpen(true)}>
        Edit
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`${channel.key} channel`}
        description={`${channel.through ?? channel.kind} · ${channel.from ?? "provider default sender"}`}
        width={600}
      >
        <div className="stack">
          <div className="usage">
            {usage.length === 0 ? (
              <p className="muted">No limit set, so nothing is being counted.</p>
            ) : (
              usage.map((w) => (
                <div key={w.label} className="usage-row">
                  <span className={`pill ${w.free === 0 ? "bad" : "ok"}`}>
                    {w.used}/{w.limit}
                  </span>
                  <span>
                    {WINDOW_LABEL[w.label] ?? w.label}
                    <span className="muted">
                      {" · "}
                      {w.free === 0 ? "nothing can send" : `${w.free} can send now`}
                      {w.freesAt ? ` · next slot ${windowTime(w.freesAt)}` : ""}
                    </span>
                  </span>
                </div>
              ))
            )}
            {/* The window is rolling, and everyone reads a daily cap as a midnight reset.
                Saying so here is cheaper than explaining it after a batch stalls. */}
            <p className="muted">
              Every window rolls. A send frees its own slot exactly 24 hours after it went out, not at
              midnight — so this count falls on its own as old sends age out. The cap is shared by every
              campaign on this channel.
            </p>
          </div>

          {/* Closing on save is what tells you it saved: the page behind revalidates, so
              leaving the drawer open shows stale numbers over fresh ones. */}
          <form
            action={async (formData) => {
              await action(formData);
              setOpen(false);
            }}
            className="stack"
          >
            {channel.kind === "mcp" && toolChoices.length > 0 && (
              <>
                <SendToolFields
                  choices={toolChoices}
                  defaultValue={channel.sendTool}
                  currentArgs={channel.sendArgs}
                  defaultReturnPath={channel.returnMessageId}
                />
                {/* The binding is per connection, not per channel, so this is worth saying
                    out loud rather than discovering after another channel changes with it. */}
                <p className="sub" style={{ margin: 0 }}>
                  The mapping belongs to the connection: any other channel sending through the same server
                  changes with it. Picking a tool on a different server moves this channel to that server.
                </p>
              </>
            )}

            <div className="grid">
              <label>
                Channel
                <select name="key" defaultValue={channel.key}>
                  <option value="email">email</option>
                  <option value="whatsapp">whatsapp</option>
                  <option value="sms">sms</option>
                  <option value="in_app">in_app</option>
                  <option value="push">push</option>
                </select>
              </label>
              <label>
                Status
                <select name="status" defaultValue={channel.status}>
                  <option value="healthy">healthy — sends and is planned into</option>
                  <option value="disabled">disabled — nothing sends or is planned</option>
                </select>
              </label>
            </div>

            <FormatChoice current={channel.html ? "html" : "text"} />

            <label>
              Cap per 24 hours <span className="muted">(rolling, not per calendar day)</span>
              <input name="dailyCap" type="number" min={0} defaultValue={channel.dailyCap} required />
            </label>
            <p className="sub" style={{ margin: 0 }}>
              Match these to what the provider actually allows. Setting a cap above the provider&apos;s own
              limit does not raise it — it moves the rejection from here to them, where it costs sender
              reputation.
            </p>
            <div className="grid">
              <label>
                Per minute <span className="muted">(blank = none)</span>
                <input name="perMinute" type="number" min={1} defaultValue={channel.perMinute ?? ""} />
              </label>
              <label>
                Per hour <span className="muted">(blank = none)</span>
                <input name="perHour" type="number" min={1} defaultValue={channel.perHour ?? ""} />
              </label>
            </div>

            <label>
              From <span className="muted">(blank if the provider controls it)</span>
              <input name="from" defaultValue={channel.from ?? ""} placeholder="TeamGrid <hi@teamgrid.ai>" />
            </label>
            <label>
              Reply-To <span className="muted">(where replies land)</span>
              <input name="replyTo" defaultValue={channel.replyTo ?? ""} placeholder="hello@teamgrid.ai" />
            </label>

            <div className="grid">
              <label>
                Max subject chars
                <input
                  name="maxSubjectLength"
                  type="number"
                  min={1}
                  defaultValue={channel.maxSubjectLength ?? ""}
                  placeholder="none"
                />
              </label>
              <label>
                Max body chars
                <input
                  name="maxBodyLength"
                  type="number"
                  min={1}
                  defaultValue={channel.maxBodyLength ?? ""}
                  placeholder="none"
                />
              </label>
            </div>

            <div className="drawer-foot">
              <SubmitButton pendingLabel="Saving…">Save channel</SubmitButton>
            </div>
          </form>
        </div>
      </Drawer>
    </>
  );
}
