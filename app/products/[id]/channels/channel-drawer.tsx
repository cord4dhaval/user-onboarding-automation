"use client";

import { useState } from "react";
import Drawer from "../../../ui/drawer";
import { Globe, Mail, Plug, Plus } from "lucide-react";
import { Button, SubmitButton } from "../../../ui/kit";
import { FormatChoice, SendToolFields } from "./channel-fields";

export interface ConnectionTools {
  id: string;
  provider: string;
  serverUrl: string;
  tools: Array<{
    name: string;
    description?: string;
    args: Array<{ name: string; required: boolean; type?: string; description?: string }>;
  }>;
  /** Already mapped to Send, if it was bound on the connections page. */
  boundSendTool?: string;
}

const EXAMPLE_PAYLOAD = JSON.stringify(
  { from: "$channel.from", to: "$person.email", subject: "$content.subject", text: "$content.body" },
  null,
  2,
);

type Kind = "mcp" | "smtp" | "http";

/**
 * One drawer with the alternatives as a segmented choice. Nested drawers are hard to back
 * out of — you lose track of which Escape closes what — and these three are alternatives,
 * so only one belongs on screen at a time.
 */
export default function ChannelDrawer({
  productId,
  connections,
  smtpAction,
  mcpAction,
  httpAction,
}: {
  productId: string;
  connections: ConnectionTools[];
  smtpAction: (formData: FormData) => void | Promise<void>;
  mcpAction: (formData: FormData) => void | Promise<void>;
  httpAction: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(connections.length > 0 ? "mcp" : "smtp");

  // Every tool from every connection, unfiltered. Guessing which one sends was worse than
  // asking: "mail" appears inside "email", so readers looked like senders.
  const choices = connections.flatMap((c) =>
    c.tools.map((t) => ({
      value: `${c.id}::${t.name}`,
      label: `${c.provider} → ${t.name}`,
      description: t.description,
      args: t.args,
    })),
  );

  // A tool already bound as Send on the connections page is the obvious first offer.
  const suggested =
    choices.find((c) => connections.some((k) => c.value === `${k.id}::${k.boundSendTool}`))?.value ??
    choices[0]?.value;

  const channelSelect = (
    <label>
      Channel
      <select name="key">
        <option value="email">email</option>
        <option value="whatsapp">whatsapp</option>
        <option value="sms">sms</option>
        <option value="in_app">in_app</option>
        <option value="push">push</option>
      </select>
    </label>
  );

  const limits = (
    <>
      <p className="sub" style={{ margin: 0 }}>
        The provider&apos;s own limits. The engine holds messages back rather than letting them be rejected.
      </p>
      <div className="grid">
        <label>Per minute<input name="perMinute" type="number" placeholder="20" /></label>
        <label>Per hour<input name="perHour" type="number" placeholder="100" /></label>
        <label>Daily cap<input name="dailyCap" type="number" defaultValue={50} /></label>
      </div>
      <div className="grid">
        <label>Max subject chars<input name="maxSubjectLength" type="number" placeholder="200" /></label>
        <label>Max body chars<input name="maxBodyLength" type="number" placeholder="20000" /></label>
      </div>
    </>
  );

  return (
    <>
      <Button icon={<Plus />} onClick={() => setOpen(true)}>Add channel</Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add a channel"
        description="How messages actually leave. Three ways, and any channel type can use whichever fits."
        width={600}
      >
        <div className="segmented" role="tablist" aria-label="Connection type">
          <button type="button" className={kind === "mcp" ? "on" : ""} onClick={() => setKind("mcp")}>
            <Plug /> MCP tool
          </button>
          <button type="button" className={kind === "smtp" ? "on" : ""} onClick={() => setKind("smtp")}>
            <Mail /> SMTP
          </button>
          <button type="button" className={kind === "http" ? "on" : ""} onClick={() => setKind("http")}>
            <Globe /> API endpoint
          </button>
        </div>

        {kind === "mcp" && (
          <>
            {choices.length === 0 ? (
              <div className="empty" style={{ marginTop: 18 }}>
                <strong>No MCP connection with discovered tools</strong>
                <p style={{ margin: "6px 0 0" }}>
                  <a href={`/products/${productId}/connections`}>Connect a server</a> and run Discover tools.
                </p>
              </div>
            ) : (
              <form action={mcpAction} className="stack" style={{ marginTop: 18 }}>
                <input type="hidden" name="productId" value={productId} />

                <SendToolFields choices={choices} defaultValue={suggested} />

                {channelSelect}
                <FormatChoice />
                <label>
                  From <span className="muted">(leave blank if the provider controls it)</span>
                  <input name="from" placeholder="TeamGrid <hi@teamgrid.ai>" />
                </label>
                <label>
                  Reply-To <span className="muted">(where replies land)</span>
                  <input name="replyTo" placeholder="hello@teamgrid.ai" />
                </label>
                {limits}
                <SubmitButton pendingLabel="Creating…">Create channel</SubmitButton>
              </form>
            )}
          </>
        )}

        {kind === "smtp" && (
          <form action={smtpAction} className="stack" style={{ marginTop: 18 }}>
            <input type="hidden" name="productId" value={productId} />
            <p className="sub" style={{ margin: 0 }}>
              Any mail account: a Gmail app password, Zoho, Brevo, your own server. The password is encrypted on
              arrival and never shown again.
            </p>
            <label>Name<input name="provider" defaultValue="smtp" /></label>
            <div className="grid">
              <label>Host<input name="host" placeholder="smtp.gmail.com" required /></label>
              <label>Port<input name="port" type="number" defaultValue={587} /></label>
            </div>
            <label>Username<input name="user" placeholder="you@yourdomain.com" required /></label>
            <label>Password<input name="pass" type="password" placeholder="app password" required /></label>
            <label>From<input name="from" placeholder="TeamGrid <hi@yourdomain.com>" required /></label>
            <label>
              Reply-To <span className="muted">(where replies land)</span>
              <input name="replyTo" placeholder="hello@yourdomain.com" />
            </label>
            <FormatChoice />
            {limits}
            <SubmitButton pendingLabel="Creating…">Create email channel</SubmitButton>
          </form>
        )}

        {kind === "http" && (
          <form action={httpAction} className="stack" style={{ marginTop: 18 }}>
            <input type="hidden" name="productId" value={productId} />
            <p className="sub" style={{ margin: 0 }}>
              Any provider that takes a token over HTTP. The payload describes their body shape — no two
              providers name these fields the same way, so the mapping is yours to give.
            </p>
            <label>Name<input name="provider" placeholder="Resend, Postmark, your own service" required /></label>
            {channelSelect}
            <label>Endpoint<input name="endpointUrl" type="url" placeholder="https://api.resend.com/emails" required /></label>
            <label>Token<input name="token" type="password" placeholder="bearer token" required /></label>
            <label>
              Payload <span className="muted">(their field names, our values)</span>
              <textarea name="payloadTemplate" defaultValue={EXAMPLE_PAYLOAD} style={{ minHeight: 130 }} />
            </label>
            <div className="grid">
              <label>
                Where their id lives <span className="muted">(optional)</span>
                <input name="messageIdPath" placeholder="$.id" />
              </label>
              <label>
                Auth header <span className="muted">(if not Authorization)</span>
                <input name="authHeader" placeholder="x-api-key" />
              </label>
            </div>
            <label>From<input name="from" placeholder="TeamGrid <hi@yourdomain.com>" /></label>
            <label>
              Reply-To <span className="muted">(where replies land)</span>
              <input name="replyTo" placeholder="hello@yourdomain.com" />
            </label>
            <FormatChoice />
            {limits}
            <SubmitButton pendingLabel="Creating…">Create channel</SubmitButton>
          </form>
        )}
      </Drawer>
    </>
  );
}
