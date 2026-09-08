"use client";

import { useState } from "react";
import Drawer from "../../../ui/drawer";
import { Globe, Mail, Plug, ShieldCheck, Server } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";
import { FormatChoice, SendToolFields } from "./channel-fields";
import { catalogById, transportsFor, type TransportId } from "@/channels/catalog.js";
import Select from "../../../ui/select";

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

const TRANSPORT_ICONS: Record<TransportId, React.ReactNode> = {
  oauth: <ShieldCheck />,
  ses: <Server />,
  mcp: <Plug />,
  smtp: <Mail />,
  http: <Globe />,
};

/**
 * How one already-chosen channel connects.
 *
 * Which channel is no longer asked here. That question is answered by the cards on the
 * page behind — the list of channels is the picker — so this drawer opens knowing what it
 * is connecting and only has the second question left: sign in, an MCP tool, SMTP or an
 * endpoint. Asking "which channel" twice was how someone could pick Gmail on the way in
 * and create an SMS channel on the way out.
 */
export default function ChannelDrawer({
  productId,
  optionId,
  open,
  onClose,
  connections,
  smtpAction,
  mcpAction,
  httpAction,
  googleAction,
  sesAction,
  googleReady,
  sesReady,
  mailboxes,
}: {
  productId: string;
  /** Which catalogue entry was clicked on the page behind. */
  optionId: string;
  open: boolean;
  onClose: () => void;
  connections: ConnectionTools[];
  smtpAction: (formData: FormData) => void | Promise<void>;
  mcpAction: (formData: FormData) => void | Promise<void>;
  httpAction: (formData: FormData) => void | Promise<void>;
  googleAction: (formData: FormData) => void | Promise<void>;
  sesAction: (formData: FormData) => void | Promise<void>;
  /** Whether this deployment has an OAuth client at all. Checked on the server: the id is
   * not a secret, but a client component has no way to read it. */
  googleReady: boolean;
  /** Whether this deployment has AWS credentials. Same reasoning as googleReady. */
  sesReady: boolean;
  /** Connected Google mailboxes that could read this channel's replies. SES sends and never
   * receives, so without one of these there is nowhere for an answer to arrive. */
  mailboxes: Array<{ id: string; email: string; canRead: boolean }>;
}) {
  const option = catalogById(optionId);
  const transports = transportsFor(optionId);
  // Signing in is preselected wherever the channel offers it: it is the only transport
  // that stores no password and needs no field mapping, so anything else as the default is
  // a nudge towards more work. A channel without it opens on its own first transport.
  const [transport, setTransport] = useState<TransportId>(transports[0]?.id ?? "smtp");
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

  // The channel key travels as a hidden field now that the card decided it. The server
  // actions read the same name they always did, so nothing downstream changed.
  const channelKey = <input type="hidden" name="key" value={option?.channelKey ?? "email"} />;

  // A connected Google account is not the same as one that can read. Someone who unticked
  // the read permission has a mailbox that sends perfectly and would pair with a domain to
  // produce a channel whose every reply is invisible.
  const readable = mailboxes.filter((m) => m.canRead);

  const limits = (
    <>
      <p className="sub tight">
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
    <Drawer
      open={open}
      onClose={onClose}
      title={`Connect ${option?.label ?? "channel"}`}
      description={option?.blurb}
      width={600}
    >
      {/* Not live natively is not the same as unreachable: a tenant with their own
          endpoint or send tool can run WhatsApp today, and saying so beats a dead card. */}
      {option?.status === "soon" && (
        <div className="note">
          <p>
            <strong>{option.label}</strong> is not live natively yet — waiting on{" "}
            {option.waitingOn ?? "provider setup"}. Your own provider works today: connect the endpoint or send
            tool below and messages go out on it.
          </p>
        </div>
      )}

      {/* The one question left. Signing in sits in this row rather than above it, because
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
            {t.id === "oauth" && option?.label ? `Sign in with ${option.label}` : t.label}
          </button>
        ))}
      </div>

      {active === "oauth" && !googleReady && (
        <div className="empty drawer-block">
          <strong>This deployment has no Google OAuth client yet</strong>
          <p>
            Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then restart. The full walkthrough
            is in <code>docs/google-oauth-setup.md</code>. Until then, SMTP or an API endpoint still work.
          </p>
        </div>
      )}

      {active === "oauth" && googleReady && (
        <form action={googleAction} className="stack drawer-block">
          <input type="hidden" name="productId" value={productId} />
          <p className="sub tight">
            Sign in with Google and approve the mailbox. No password is typed here and none is stored — we hold a
            token the account can revoke at any time.
          </p>
          <p className="sub tight">
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

      {active === "ses" && !sesReady && (
        <div className="empty drawer-block">
          <strong>This deployment has no AWS credentials yet</strong>
          <p>
            Set <code>AWS_REGION</code>, <code>AWS_ACCESS_KEY_ID</code> and <code>AWS_SECRET_ACCESS_KEY</code>, then
            restart. The full walkthrough is in <code>docs/amazon-ses-setup.md</code>. Until then, signing in with
            Gmail still works.
          </p>
        </div>
      )}

      {/* Not a warning at the bottom of a form somebody already filled in. SES can send and
          can never receive, so a domain without a mailbox beside it mails people whose
          answers nobody will ever see — and the campaign keeps chasing them. The step is
          shown first, and the form is not offered until it is done. */}
      {active === "ses" && sesReady && readable.length === 0 && (
        <div className="empty drawer-block">
          <strong>Connect Gmail first</strong>
          <p>
            Amazon SES sends mail and never receives it, so replies still arrive in your normal mailbox — and we read
            them from there. Sign in with Google above, leaving the read permission ticked, then come back and add
            your domain.
          </p>
          <p className="sub tight">
            {mailboxes.length > 0
              ? "A Google account is connected, but without permission to read replies. Connect it again and leave every box ticked."
              : "Nothing is connected yet."}
          </p>
        </div>
      )}

      {active === "ses" && sesReady && readable.length > 0 && (
        <form action={sesAction} className="stack drawer-block">
          <input type="hidden" name="productId" value={productId} />
          <p className="sub tight">
            Send as your own domain rather than one mailbox. Amazon delivers it, so Google&rsquo;s 500 and 2,000 a
            day caps do not apply — the limits become Amazon&rsquo;s, and they are far higher.
          </p>
          <p className="sub tight">
            You will be given three DNS records to publish. Nothing sends until they are live and Amazon has
            confirmed them, which takes minutes to a few hours.
          </p>

          <label>
            Your domain
            <input name="domain" placeholder="yourcompany.com" required />
          </label>
          <label>
            Send as
            <input name="from" type="email" placeholder="hello@yourcompany.com" />
            <span className="sub tight">Has to be an address on that domain. Defaults to hello@ it.</span>
          </label>

          <label>
            Replies arrive in
            <Select
              name="inboxConnectionId"
              value={readable[0]?.id ?? ""}
              searchable={readable.length > 8}
              ariaLabel="Mailbox replies arrive in"
              placeholder="— no readable mailbox connected —"
              options={readable.map((m) => ({ value: m.id, label: m.email }))}
            />
            <span className="sub tight">
              The mailbox we read answers from. Required — a domain cannot receive.
            </span>
          </label>

          <label>
            Reply-To <span className="muted">(optional)</span>
            <input name="replyTo" type="email" placeholder="you@yourcompany.com" />
          </label>

          <SubmitButton pendingLabel="Registering the domain…">Add domain</SubmitButton>
        </form>
      )}

      {active === "mcp" && (
        <>
          {choices.length === 0 ? (
            <div className="empty drawer-block">
              <strong>No MCP connection with discovered tools</strong>
              <p>
                <a href={`/products/${productId}/connections`}>Connect a server</a> and run Discover tools.
              </p>
            </div>
          ) : (
            <form action={mcpAction} className="stack drawer-block">
              <input type="hidden" name="productId" value={productId} />
              {channelKey}

              <SendToolFields choices={choices} defaultValue={suggested} />

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
        <form action={smtpAction} className="stack drawer-block">
          <input type="hidden" name="productId" value={productId} />
          <p className="sub tight">
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
        <form action={httpAction} className="stack drawer-block">
          <input type="hidden" name="productId" value={productId} />
          {channelKey}
          <p className="sub tight">
            Any provider that takes a token over HTTP. The payload describes their body shape — no two
            providers name these fields the same way, so the mapping is yours to give.
          </p>
          <label>
            Which service <span className="muted">(so two endpoints can be told apart)</span>
            <input name="provider" placeholder="resend" required />
          </label>
          <label>Endpoint<input name="endpointUrl" type="url" placeholder="https://api.resend.com/emails" required /></label>
          <label>Token<input name="token" type="password" placeholder="bearer token" required /></label>
          <label>
            Payload <span className="muted">(their field names, our values)</span>
            <textarea name="payloadTemplate" defaultValue={EXAMPLE_PAYLOAD} className="payload" />
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
  );
}
