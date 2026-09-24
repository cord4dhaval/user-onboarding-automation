"use client";

import { useState, type ReactNode } from "react";
import { Contact, Mail, MessageCircle, PhoneCall, Plug, Plus, Smartphone } from "lucide-react";
import { Button } from "../../../ui/kit";
import ChannelDrawer, { type ConnectionTools } from "./channel-drawer";
import { CHANNEL_CATALOG } from "@/channels/catalog.js";

/** One icon per kind of message, kept here because the catalogue itself is server-shared. */
const ICONS: Record<string, ReactNode> = {
  email: <Mail />,
  whatsapp: <MessageCircle />,
  voice: <PhoneCall />,
  sms: <Smartphone />,
  linkedin: <Contact />,
  other: <Plug />,
};

/** What is already sending, on one key. */
export interface ChannelGroup {
  /** The channel key — `email`, `voice` — which is what the group is. */
  key: string;
  /** What that key carries, in the catalogue's words: "Email", "AI call". */
  label: string;
  /**
   * Server-rendered sender rows: the live values, with every action already bound.
   * Rendered on the server because usage and limits are read from the database, and
   * passed through as nodes so this component stays a shell.
   */
  rows: ReactNode[];
}

/**
 * The channel list and the channel picker, as one page.
 *
 * Both used to be cards in one grid: a card per catalogue entry, connected or not, each
 * holding its own senders. With four mailboxes on email and nothing on WhatsApp that grid
 * put a column of forty lines beside a card of three, and the eye had to climb the tall
 * one to reach anything else. So the two questions get the two shapes they want.
 *
 * What is sending is a full-width group per kind of message, one row per sender, because a
 * sender carries five facts and four controls and those read across rather than down. What
 * could be added is a row of equal tiles underneath — still on the page and never behind a
 * button, but no longer competing for height with a mailbox that has been live a month.
 */
export default function ChannelCards({
  productId,
  connections,
  groups,
  googleReady,
  sesReady,
  mailboxes,
  smtpAction,
  mcpAction,
  httpAction,
  bolnaAction,
  linkedinAction,
  googleAction,
  metaConfig,
  sesAction,
}: {
  productId: string;
  connections: ConnectionTools[];
  groups: ChannelGroup[];
  googleReady: boolean;
  sesReady: boolean;
  /** Google mailboxes that could read an SES channel's replies, and whether each actually
   * has the read permission. */
  mailboxes: Array<{ id: string; email: string; canRead: boolean }>;
  smtpAction: (formData: FormData) => void | Promise<void>;
  mcpAction: (formData: FormData) => void | Promise<void>;
  httpAction: (formData: FormData) => void | Promise<void>;
  bolnaAction: (formData: FormData) => void | Promise<void>;
  linkedinAction: (formData: FormData) => void | Promise<void>;
  googleAction: (formData: FormData) => void | Promise<void>;
  /** The Meta app this deployment signs in through, or null where none is configured. */
  metaConfig: { appId: string; configId: string; signupLink: string } | null;
  sesAction: (formData: FormData) => void | Promise<void>;
}) {
  // Which channel is being connected, or nothing. Keyed remount below resets the transport
  // choice per channel, so opening SMS never shows the tab Gmail was left on.
  const [picking, setPicking] = useState<string | null>(null);

  // Everything the catalogue offers that nothing is sending on yet. What is not live is
  // listed too: someone who needs WhatsApp should find that out here rather than after
  // connecting email and waiting.
  const unconnected = CHANNEL_CATALOG.filter((o) => !groups.some((g) => g.key === o.channelKey));

  return (
    <>
      {groups.length > 0 && (
        <div className="channel-groups">
          {groups.map((group) => {
            // The catalogue entry for this key, where there is one — it is what the connect
            // drawer opens on. A key the catalogue does not carry still draws its senders;
            // it just has nothing to add another of.
            const option = CHANNEL_CATALOG.find((o) => o.channelKey === group.key);

            return (
              <section className="channel-group" key={group.key}>
                <header>
                  {ICONS[group.key] ?? ICONS.other}
                  <h3>{group.label}</h3>
                  <span className="pill ok">
                    {group.rows.length} {group.rows.length === 1 ? "sender" : "senders"}
                  </span>
                  <span className="spacer" />
                  {option && (
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<Plus />}
                      onClick={() => setPicking(option.id)}
                    >
                      Connect another
                    </Button>
                  )}
                </header>
                {group.rows}
              </section>
            );
          })}
        </div>
      )}

      {unconnected.length > 0 && (
        <>
          <div className="section-head">
            <h2>{groups.length > 0 ? "Add another channel" : "Connect a channel"}</h2>
          </div>
          <div className="channel-tiles">
            {unconnected.map((option) => (
              // The whole tile is the button. A tile that opens a form only when a small
              // control at its edge is hit reads as broken to everyone who clicked the tile
              // itself first.
              <button
                key={option.id}
                type="button"
                className="channel-tile"
                onClick={() => setPicking(option.id)}
              >
                <span className="channel-head">
                  {ICONS[option.channelKey] ?? ICONS.other}
                  <strong>{option.label}</strong>
                  {option.status === "soon" && <span className="pill">Soon</span>}
                </span>
                <p className="blurb">
                  {option.status === "soon" && option.waitingOn ? option.waitingOn : option.blurb}
                </p>
                <span className="channel-cta">
                  {option.status === "soon" ? "Connect your own provider" : `Connect ${option.label}`}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Remounted per channel so each opens on its own best transport rather than on
          whichever tab the previous one was left on. */}
      {picking && (
        <ChannelDrawer
          key={picking}
          productId={productId}
          optionId={picking}
          open
          onClose={() => setPicking(null)}
          connections={connections}
          googleReady={googleReady}
          sesReady={sesReady}
          mailboxes={mailboxes}
          smtpAction={smtpAction}
          mcpAction={mcpAction}
          httpAction={httpAction}
          bolnaAction={bolnaAction}
          linkedinAction={linkedinAction}
          googleAction={googleAction}
                  metaConfig={metaConfig}
          sesAction={sesAction}
        />
      )}
    </>
  );
}
