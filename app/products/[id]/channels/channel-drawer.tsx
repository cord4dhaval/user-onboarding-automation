"use client";

import { useState } from "react";
import Drawer from "../../../ui/drawer";
import { Globe, Mail, MessageCircle, Plug, Plus, ShieldCheck, Smartphone } from "lucide-react";
import { Button, SubmitButton } from "../../../ui/kit";
import { FormatChoice, SendToolFields } from "./channel-fields";
import { catalogById, CHANNEL_CATALOG, transportsFor, type TransportId } from "@/channels/catalog.js";

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

/** One icon per catalogue entry, kept here because the catalogue itself is server-shared. */
const ICONS: Record<string, React.ReactNode> = {
  google: <ShieldCheck />,
  whatsapp: <MessageCircle />,
  sms: <Smartphone />,
};

const TRANSPORT_ICONS: Record<TransportId, React.ReactNode> = {
  oauth: <ShieldCheck />,
  mcp: <Plug />,
  smtp: <Mail />,
  http: <Globe />,
};

/**
 * One drawer, two questions in order: which channel, then how it connects. Nested drawers
 * are hard to back out of — you lose track of which Escape closes what — and the answers to
 * each question are alternatives, so only one form belongs on screen at a time.
 */
export default function ChannelDrawer({
  productId,
  connections,
  smtpAction,
  mcpAction,
  httpAction,
  googleAction,
  googleReady,
}: {
  productId: string;
  connections: ConnectionTools[];
  smtpAction: (formData: FormData) => void | Promise<void>;
  mcpAction: (formData: FormData) => void | Promise<void>;
  httpAction: (formData: FormData) => void | Promise<void>;
  googleAction: (formData: FormData) => void | Promise<void>;
  /** Whether this deployment has an OAuth client at all. Checked on the server: the id is
   * not a secret, but a client component has no way to read it. */
  googleReady: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Gmail is preselected because it is the only entry that needs no password, no endpoint
  // and no field mapping. Anything else as the default is a nudge towards more work for a
  // worse channel.
  const [picked, setPicked] = useState("google");
  // Which channel first, how it connects second. Signing in is preselected wherever the
  // channel offers it: it is the only transport that stores no password and needs no field
  // mapping, so anything else as the default is a nudge towards more work.
  const [transport, setTransport] = useState<TransportId>("oauth");
  const transports = transportsFor(picked);
  // A channel that does not offer the selected transport falls back to its first, rather
  // than rendering nothing and looking broken.
  const active: TransportId = transports.some((t) => t.id === transport)
    ? transport
    : (transports[0]?.id ?? "smtp");

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

  // The same fixed list as the picker. A bring-your-own connection may serve a channel we
  // have not built natively yet — someone with their own WhatsApp endpoint is not blocked
  // by our roadmap — so the not-yet entries stay selectable here and say why they are safe.
  const channelSelect = (
    <label>
      Channel
      <select name="key">
        {CHANNEL_CATALOG.filter((c) => c.id !== "byo").map((c) => (
          <option key={c.channelKey} value={c.channelKey}>
            {c.typeLabel}
            {c.status === "soon" ? " — your own provider" : ""}
          </option>
        ))}
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
        description="Which channel this product sends on. What is not live yet is listed too."
        width={600}
      >
        <div className="picker">
          {CHANNEL_CATALOG.map((option) => (
            <button
              key={option.id}
              type="button"
              className={picked === option.id ? "on" : ""}
              // A channel that is not built yet stays visible and stays unclickable. Hiding
              // it would answer "can this do WhatsApp" with silence; enabling it would
              // answer with a form that leads nowhere.
              disabled={option.status === "soon"}
              onClick={() => setPicked(option.id)}
            >
              <span className="picker-top">
                {ICONS[option.id]}
                <strong>{option.label}</strong>
                {option.status === "soon" && <span className="pill">Soon</span>}
              </span>
              <p>{option.status === "soon" && option.waitingOn ? option.waitingOn : option.blurb}</p>
            </button>
          ))}
        </div>

        {/* The second question. Signing in sits in this row rather than above it, because
            it is one way of connecting the channel and not a category of its own. */}
        <div className="segmented" role="tablist" aria-label="How it connects">
          {transports.map((t) => (
            <button
              key={t.id}
              type="button"
              className={active === t.id ? "on" : ""}
              onClick={() => setTransport(t.id)}
              title={t.blurb}
            >
              {TRANSPORT_ICONS[t.id]}{" "}
              {t.id === "oauth" && catalogById(picked)?.label
                ? `Sign in with ${catalogById(picked)!.label}`
                : t.label}
            </button>
          ))}
        </div>

        {active === "oauth" && !googleReady && (
          <div className="empty" style={{ marginTop: 18 }}>
            <strong>This deployment has no Google OAuth client yet</strong>
            <p style={{ margin: "6px 0 0" }}>
              Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then restart. The full walkthrough
              is in <code>docs/google-oauth-setup.md</code>. Until then, SMTP or an API endpoint still work.
            </p>
          </div>
        )}

        {active === "oauth" && googleReady && (
          <form action={googleAction} className="stack" style={{ marginTop: 18 }}>
            <input type="hidden" name="productId" value={productId} />
            <p className="sub" style={{ margin: 0 }}>
              Sign in with Google and approve the mailbox. No password is typed here and none is stored — we hold a
              token the account can revoke at any time.
            </p>
            <p className="sub" style={{ margin: 0 }}>
              Mail leaves the mailbox itself, so it lands where a person&rsquo;s mail lands. Google caps that at 500 a
              day on a personal account and 2,000 on Workspace; the channel is created at 200 a day and the cap is
              editable afterwards.
            </p>
            <label>
              Which account <span className="muted">(optional, pre-selects it on Google&rsquo;s screen)</span>
              <input name="loginHint" type="email" placeholder="you@yourdomain.com" />
            </label>
            <SubmitButton pendingLabel="Opening Google…">Continue with Google</SubmitButton>
          </form>
        )}

        {active === "mcp" && (
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

        {active === "smtp" && (
          <form action={smtpAction} className="stack" style={{ marginTop: 18 }}>
            <input type="hidden" name="productId" value={productId} />
            <p className="sub" style={{ margin: 0 }}>
              Any mail account: a Gmail app password, Zoho, Brevo, your own server. The password is encrypted on
              arrival and never shown again.
            </p>
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

        {active === "http" && (
          <form action={httpAction} className="stack" style={{ marginTop: 18 }}>
            <input type="hidden" name="productId" value={productId} />
            <p className="sub" style={{ margin: 0 }}>
              Any provider that takes a token over HTTP. The payload describes their body shape — no two
              providers name these fields the same way, so the mapping is yours to give.
            </p>
            <label>
              Which service <span className="muted">(so two endpoints can be told apart)</span>
              <input name="provider" placeholder="resend" required />
            </label>
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
