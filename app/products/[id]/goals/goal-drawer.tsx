"use client";

import { useState } from "react";
import Drawer from "../../../ui/drawer";
import InputPicker, { type AudienceChoice, type ToolChoice } from "./input-picker";

export interface VerifierChoice {
  id: string;
  provider: string;
  tools: number;
}

export default function GoalDrawer({
  productId,
  templateKeys,
  channelKeys,
  toolChoices,
  audiences,
  verifiers,
  action,
}: {
  productId: string;
  templateKeys: string[];
  channelKeys: string[];
  toolChoices: ToolChoice[];
  audiences: AudienceChoice[];
  verifiers: VerifierChoice[];
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>New goal</button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="New goal"
        description="What comes in, what happens the moment it does, and what counts as done."
        width={560}
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />

          <div className="grid">
            <label>Key<input name="key" placeholder="new_user" required /></label>
            <label>Name<input name="name" placeholder="New user onboarding" required /></label>
          </div>

          <label>
            Done when <span className="muted">(plain words — what activation actually looks like)</span>
            <input
              name="successDescribed"
              defaultValue="Account created, two teammates tracked, one report opened"
              required
            />
          </label>

          <InputPicker productId={productId} toolChoices={toolChoices} audiences={audiences} />

          <h3 style={{ fontSize: 15, margin: "18px 0 0" }}>How we will know it worked</h3>
          <p className="sub" style={{ margin: 0 }}>
            Pick where the truth lives. Claude works out which of that server&apos;s tools answer your sentence
            above, and writes the checks on its next run — a browser cannot ask it directly.
          </p>

          <label>
            Verify against
            <select name="verifyConnectionId" defaultValue={verifiers[0]?.id ?? ""}>
              {verifiers.length === 0 && <option value="">— nothing connected that can answer —</option>}
              {verifiers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.provider} — {v.tools} tools
                </option>
              ))}
            </select>
            {verifiers.length === 0 && (
              <span className="muted" style={{ fontSize: 13 }}>
                <a href={`/products/${productId}/connections`}>Connect a server</a> and run Discover tools. Until
                then this campaign can send, but cannot tell when anyone has succeeded.
              </span>
            )}
          </label>

          <label>
            Anything Claude should know <span className="muted">(optional)</span>
            <input
              name="verifyHint"
              placeholder="Accounts are found by work email, not personal"
            />
          </label>

          <h3 style={{ fontSize: 15, margin: "18px 0 0" }}>What happens on arrival</h3>

          <fieldset className="fieldset">
            <legend>Channels this campaign may use</legend>
            {channelKeys.length === 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                None connected yet — <a href={`/products/${productId}/channels`}>connect one</a>.
              </span>
            ) : (
              channelKeys.map((k) => (
                <label key={k} className="check">
                  <input type="checkbox" name="allowedChannels" value={k} defaultChecked={k === channelKeys[0]} />
                  {k}
                </label>
              ))
            )}
          </fieldset>
          <p className="sub" style={{ margin: 0 }}>
            Claude plans within this set and never outside it. Ticking WhatsApp does not mean every message
            goes there — it means a later step is allowed to.
          </p>

          <div className="grid">
            <label>
              Send
              <select name="firstTouchTemplate">
                {templateKeys.length === 0 && <option value="welcome">welcome</option>}
                {templateKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label>
              Via
              <select name="primaryChannel" defaultValue={channelKeys[0] ?? "email"}>
                {channelKeys.length === 0 && <option value="email">email</option>}
                {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          </div>

          {channelKeys.length === 0 && (
            <p className="sub" style={{ margin: 0 }}>
              No channel is connected yet, so nothing will send until one is.{" "}
              <a href={`/products/${productId}/channels`}>Connect one</a>.
            </p>
          )}

          <label>
            If that is unavailable <span className="muted">(optional fallback)</span>
            <select name="fallbackChannel" defaultValue="">
              <option value="">— none —</option>
              {channelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>

          <div className="grid">
            <label>Max messages<input name="touches" type="number" defaultValue={9} /></label>
            <label>Max days<input name="days" type="number" defaultValue={30} /></label>
          </div>

          <label>
            Before sending
            <select name="approvalMode" defaultValue="gate_on">
              <option value="gate_on">Hold each for review</option>
              <option value="auto_send">Send automatically</option>
            </select>
          </label>

          <details>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Advanced</summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <label>
                Field map <span className="muted">(ours → theirs; blank means guess from the headers)</span>
                <textarea name="fieldMap" placeholder='{"email":"Email","name":"Name","role":"Title"}' />
              </label>
              <label>Dedupe on<input name="dedupeKey" defaultValue="email" /></label>
              <label>
                Success expression <span className="muted">(checked against product events)</span>
                <input
                  name="successExpression"
                  defaultValue="account_created AND teammates_invited >= 2 AND report_viewed >= 1"
                />
              </label>
              <div className="grid">
                <label>Spend cap ($)<input name="usd" type="number" defaultValue={12} /></label>
                <label>Tick every (s)<input name="tickEverySec" type="number" defaultValue={600} /></label>
                <label>Give up after (days silent)<input name="silenceDays" type="number" defaultValue={30} /></label>
              </div>
            </div>
          </details>

          <button type="submit">Create goal</button>
        </form>
      </Drawer>
    </>
  );
}
