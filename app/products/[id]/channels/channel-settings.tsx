"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import { FormatChoice, SendToolFields, type ToolChoice } from "./channel-fields";
import { WINDOW_LABEL, windowTime, type UsageWindow } from "./windows";
import Select from "../../../ui/select";

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
  /** Who this channel is allowed to write to. */
  audience: string[];
  /** People currently bound to it, so switching it off is a decision with a size. */
  assignedLeads: number;
}

const AUDIENCES = [
  { value: "cold", label: "cold", hint: "strangers, first contact" },
  { value: "warm_lead", label: "warm lead", hint: "engaged, not signed up" },
  { value: "existing_user", label: "existing user", hint: "already using the product" },
] as const;

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
            {/* Sections, in the order somebody actually uses them.
                Everything here was one flat column that opened on seven argument-mapping
                fields, so the two controls people came for — is it on, and who does it
                write to — were below the fold on the channel most likely to need them. */}
            <label>
              Status
              <Select
                name="status"
                value={channel.status}
                ariaLabel="Channel status"
                options={[
                  { value: "healthy", label: "healthy", hint: "sends and is planned into" },
                  { value: "disabled", label: "disabled", hint: "nothing sends or is planned" },
                ]}
              />
            </label>
            {channel.assignedLeads > 0 && (
              <p className="sub tight">
                {channel.assignedLeads} {channel.assignedLeads === 1 ? "person is" : "people are"} being
                written to from here. Disabling moves the ones who have not replied to another mailbox, on a
                new thread; anyone who has replied is held until this comes back, rather than being answered
                from an address they have never seen.
              </p>
            )}

            <h3 className="drawer-section">Audience</h3>
            {/* Which people this mailbox is for.
                The engine has filtered on this since channels existed and nothing ever set
                it, so a mailbox bought to cold-mail strangers and the address a product's
                own users already reply to were one pool. Cold outbound belongs on a sending
                identity that can afford to be complained about; existing users belong on
                the one they know. */}
            <fieldset className="fieldset">
              <legend>Who this channel writes to</legend>
              {AUDIENCES.map((a) => (
                <label key={a.value} className="check">
                  <input
                    type="checkbox"
                    name="audience"
                    value={a.value}
                    defaultChecked={channel.audience.includes(a.value)}
                  />
                  {a.label}
                  <span className="muted"> · {a.hint}</span>
                </label>
              ))}
            </fieldset>
            <p className="sub tight">
              A lead is bound to one mailbox at their first message and stays there for the
              whole sequence, so this decides which people it is ever given — not which
              individual messages. Unticking everything leaves it serving everyone.
            </p>

            <h3 className="drawer-section">Limits</h3>
            <label>
              Cap per 24 hours <span className="muted">(rolling, not per calendar day)</span>
              <input name="dailyCap" type="number" min={0} defaultValue={channel.dailyCap} required />
            </label>
            <p className="sub tight">
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

            <h3 className="drawer-section">Message</h3>
            <FormatChoice current={channel.html ? "html" : "text"} />
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

            {/* Folded away, and correctly so. The send-tool mapping is set once when the
                channel is connected and touched again only when a provider changes its
                arguments; the channel kind is close to never. Both were open at the top of
                this drawer, which is why finding Status meant scrolling past seven fields
                nobody was looking for. */}
            <details className="drawer-advanced">
              <summary>Advanced</summary>
              <div className="stack">
                {channel.kind === "mcp" && toolChoices.length > 0 && (
                  <>
                    <SendToolFields
                      choices={toolChoices}
                      defaultValue={channel.sendTool}
                      currentArgs={channel.sendArgs}
                      defaultReturnPath={channel.returnMessageId}
                    />
                    {/* The binding is per connection, not per channel, so this is worth
                        saying out loud rather than discovering after another channel
                        changes with it. */}
                    <p className="sub tight">
                      The mapping belongs to the connection: any other channel sending through the same
                      server changes with it. Picking a tool on a different server moves this channel to
                      that server.
                    </p>
                  </>
                )}
                <label>
                  Channel kind
                  <Select
                    name="key"
                    value={channel.key}
                    ariaLabel="Channel kind"
                    options={["email", "whatsapp", "sms", "in_app", "push"].map((k) => ({ value: k, label: k }))}
                  />
                  <span className="muted">
                    What campaigns ask for by name. Changing it moves this channel out of every campaign
                    that names the old one.
                  </span>
                </label>
              </div>
            </details>

            <div className="drawer-foot">
              <SubmitButton pendingLabel="Saving…">Save channel</SubmitButton>
            </div>
          </form>
        </div>
      </Drawer>
    </>
  );
}
