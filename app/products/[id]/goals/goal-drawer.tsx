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
                value={existing?.primaryChannel ?? channelKeys[0] ?? "email"}
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

          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Creating…"}>
            {isEdit ? "Save changes" : "Create campaign"}
          </SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
