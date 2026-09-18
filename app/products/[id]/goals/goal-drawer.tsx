"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import InputPicker, { type AudienceChoice, type ToolChoice } from "./input-picker";
import Select from "../../../ui/select";

export interface VerifierChoice {
  id: string;
  provider: string;
  tools: number;
}

/**
 * Six questions, not sixteen. Everything the engine can decide for itself — field maps,
 * dedupe keys, spend caps, tick intervals — is decided for itself; a form that asks for
 * them makes a first campaign feel like configuring a database.
 */
export default function GoalDrawer({
  productId,
  templateKeys,
  channelKeys,
  mailboxes,
  toolChoices,
  audiences,
  verifiers,
  leadTypes,
  action,
  existing,
  label,
}: {
  productId: string;
  templateKeys: string[];
  channelKeys: string[];
  /** Every connected sender, so a campaign can be held to one of them. */
  mailboxes: Array<{ id: string; key: string; from: string }>;
  toolChoices: ToolChoice[];
  audiences: AudienceChoice[];
  verifiers: VerifierChoice[];
  /** Who a campaign's leads can be, with the line that says who belongs in each. */
  leadTypes: Array<{ value: string; label: string; who: string }>;
  action: (formData: FormData) => void | Promise<void>;
  /** Present when editing. Inputs and checks are left alone — saving a form should not
      re-ingest a spreadsheet or discard a plan Claude has already written. */
  existing?: {
    key: string;
    name: string;
    successDescribed: string;
    /** Absent on campaigns created before the question was asked; saving then requires it. */
    leadType?: string;
    brief?: string;
    verifyConnectionId?: string;
    firstTouchTemplate: string;
    primaryChannel: string;
    touches: number;
    days: number;
    approvalMode: string;
    /** Empty means this campaign uses every healthy mailbox. */
    channelIds?: string[];
  };
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(existing);
  const chosenMailboxes = existing?.channelIds ?? [];
  // Which kind of channel this campaign sends on, held here so the sender list below can
  // show only the mailboxes that kind actually has. An email campaign offering the voice
  // line is an invitation to pick a sender that could never carry its messages.
  const [channelKey, setChannelKey] = useState(existing?.primaryChannel ?? channelKeys[0] ?? "email");
  const senders = mailboxes.filter((box) => box.key === channelKey);
  const [leadType, setLeadType] = useState(existing?.leadType ?? "");
  const chosenType = leadTypes.find((t) => t.value === leadType);

  return (
    <>
      <Button
        variant={isEdit ? "quiet" : "primary"}
        size={isEdit ? "sm" : "md"}
        icon={isEdit ? <Pencil /> : <Plus />}
        onClick={() => setOpen(true)}
        aria-label={isEdit ? "Edit campaign" : undefined}
      >
        {isEdit ? null : (label ?? "New campaign")}
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={isEdit ? `Edit ${existing?.name}` : "New campaign"}
        description={
          isEdit
            ? "Where people come from and the verification plan stay as they are."
            : "Who comes in, what they get, and what counts as done."
        }
        width={520}
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />
          {isEdit && <input type="hidden" name="goalKey" value={existing?.key} />}

          <label>
            Name
            <input name="name" defaultValue={existing?.name} placeholder="New user onboarding" required />
          </label>

          {/* Asked straight after the name, before anything about channels or templates. Who
              these people are decides how hard every message pushes, how long the engine
              watches before planning again and which senders may carry them; a campaign
              without it was paced as though everyone in it were a stranger. */}
          <label>
            Who are these leads
            <Select
              name="leadType"
              value={leadType}
              onValueChange={setLeadType}
              placeholder="Choose one"
              ariaLabel="Who the leads in this campaign are"
              options={leadTypes.map((t) => ({ value: t.value, label: t.label, hint: t.who }))}
            />
            <span className="hint">
              {chosenType
                ? chosenType.who
                : "Required. It sets how hard each message pushes and how long the engine waits between them."}
            </span>
          </label>

          <label>
            Done when <span className="muted">— in plain words</span>
            <input
              name="successDescribed"
              defaultValue={existing?.successDescribed ?? "Account created and one report opened"}
              required
            />
            <span className="muted" style={{ fontSize: 12.5 }}>
              Claude turns this into the checks that decide who is finished.
            </span>
          </label>

          <label>
            Who these people are <span className="muted">— optional</span>
            <textarea
              name="brief"
              rows={3}
              defaultValue={existing?.brief ?? ""}
              placeholder="Who these people are, where they came from and how to approach them."
            />
            <span className="muted" style={{ fontSize: 12.5 }}>
              Shown on every lead card. A campaign key tells a writer nothing: leads from three months ago read
              exactly like leads that arrived today unless this says so.
            </span>
          </label>

          {!isEdit && <InputPicker productId={productId} toolChoices={toolChoices} audiences={audiences} />}

          <label>
            Verified against
            {/* The empty option is present even when servers are connected. A campaign whose
                finish line is a reply or a page on your own site has nowhere to point a tool,
                and forcing it at one produced checks that asked the wrong question and passed
                everybody. Nothing is a real answer here. */}
            <Select
              name="verifyConnectionId"
              value={existing?.verifyConnectionId ?? ""}
              ariaLabel="What to verify the finish line against"
              options={[
                {
                  value: "",
                  label: verifiers.length === 0 ? "— nothing connected yet —" : "— nothing to verify against —",
                },
                ...verifiers.map((v) => ({
                  value: v.id,
                  label: v.provider,
                  hint: `${v.tools} tools`,
                })),
              ]}
            />
            <span className="reason">
              {verifiers.length === 0 ? (
                <>
                  <a href={`/products/${productId}/connections`}>Connect a server</a> to let this campaign tell
                  when someone has succeeded. It can still send without one.
                </>
              ) : (
                <>Leave this empty for a campaign that sends but never decides on its own who has finished.</>
              )}
            </span>
          </label>

          <div className="grid">
            <label>
              First message
              <Select
                name="firstTouchTemplate"
                value={existing?.firstTouchTemplate ?? templateKeys[0] ?? "welcome"}
                searchable={templateKeys.length > 8}
                ariaLabel="Template the first message uses"
                options={(templateKeys.length ? templateKeys : ["welcome"]).map((k) => ({ value: k, label: k }))}
              />
            </label>
            <label>
              Sent by
              <Select
                name="primaryChannel"
                value={channelKey}
                onValueChange={setChannelKey}
                ariaLabel="Channel this campaign sends on"
                options={(channelKeys.length ? channelKeys : ["email"]).map((k) => ({ value: k, label: k }))}
              />
            </label>
          </div>

          {channelKeys.length === 0 && (
            <p className="sub" style={{ margin: 0 }}>
              No channel is connected, so nothing will send until one is.{" "}
              <a href={`/products/${productId}/channels`}>Connect one</a>.
            </p>
          )}

          {senders.length > 1 && (
            <fieldset className="fieldset">
              <legend>Sent from</legend>
              {senders.map((box) => (
                <label key={box.id} className="check">
                  <input type="checkbox" name="channelIds" value={box.id} defaultChecked={chosenMailboxes.includes(box.id)} />
                  {box.from}
                </label>
              ))}
              <span className="reason">
                Tick none to use every healthy {channelKey} sender, with leads spread across them. Ticking one
                keeps this campaign on that sender.
              </span>
            </fieldset>
          )}

          <div className="grid">
            <label>Stop after<input name="touches" type="number" min={1} defaultValue={existing?.touches ?? 9} /></label>
            <label>Or after (days)<input name="days" type="number" min={1} defaultValue={existing?.days ?? 30} /></label>
          </div>

          <label>
            Before sending
            <Select
              name="approvalMode"
              value={existing?.approvalMode ?? "gate_on"}
              ariaLabel="Whether messages wait for a person"
              options={[
                { value: "gate_on", label: "Hold each for review", hint: "nothing leaves unapproved" },
                { value: "auto_send", label: "Send automatically", hint: "the engine sends on its own clock" },
              ]}
            />
          </label>

          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"} disabled={!leadType}>
            {isEdit ? "Save changes" : "Create campaign"}
          </SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
