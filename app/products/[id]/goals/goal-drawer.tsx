"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import InputPicker, { type AudienceChoice, type ToolChoice } from "./input-picker";

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
  toolChoices,
  audiences,
  verifiers,
  action,
  existing,
  label,
}: {
  productId: string;
  templateKeys: string[];
  channelKeys: string[];
  toolChoices: ToolChoice[];
  audiences: AudienceChoice[];
  verifiers: VerifierChoice[];
  action: (formData: FormData) => void | Promise<void>;
  /** Present when editing. Inputs and checks are left alone — saving a form should not
      re-ingest a spreadsheet or discard a plan Claude has already written. */
  existing?: {
    key: string;
    name: string;
    successDescribed: string;
    verifyConnectionId?: string;
    firstTouchTemplate: string;
    primaryChannel: string;
    touches: number;
    days: number;
    approvalMode: string;
  };
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(existing);

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

          {!isEdit && <InputPicker productId={productId} toolChoices={toolChoices} audiences={audiences} />}

          <label>
            Verified against
            <select name="verifyConnectionId" defaultValue={existing?.verifyConnectionId ?? verifiers[0]?.id ?? ""}>
              {verifiers.length === 0 && <option value="">— nothing connected yet —</option>}
              {verifiers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.provider} — {v.tools} tools
                </option>
              ))}
            </select>
            {verifiers.length === 0 && (
              <span className="muted" style={{ fontSize: 12.5 }}>
                <a href={`/products/${productId}/connections`}>Connect a server</a> to let this campaign tell
                when someone has succeeded. It can still send without one.
              </span>
            )}
          </label>

          <div className="grid">
            <label>
              First message
              <select name="firstTouchTemplate" defaultValue={existing?.firstTouchTemplate}>
                {templateKeys.length === 0 && <option value="welcome">welcome</option>}
                {templateKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label>
              Sent by
              <select name="primaryChannel" defaultValue={existing?.primaryChannel ?? channelKeys[0] ?? "email"}>
                {channelKeys.length === 0 && <option value="email">email</option>}
                {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>

          {channelKeys.length === 0 && (
            <p className="sub" style={{ margin: 0 }}>
              No channel is connected, so nothing will send until one is.{" "}
              <a href={`/products/${productId}/channels`}>Connect one</a>.
            </p>
          )}

          <div className="grid">
            <label>Stop after<input name="touches" type="number" min={1} defaultValue={existing?.touches ?? 9} /></label>
            <label>Or after (days)<input name="days" type="number" min={1} defaultValue={existing?.days ?? 30} /></label>
          </div>

          <label>
            Before sending
            <select name="approvalMode" defaultValue={existing?.approvalMode ?? "gate_on"}>
              <option value="gate_on">Hold each for review</option>
              <option value="auto_send">Send automatically</option>
            </select>
          </label>

          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : "Create campaign"}
          </SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
