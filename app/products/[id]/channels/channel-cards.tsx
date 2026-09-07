"use client";

import { useState, type ReactNode } from "react";
import { MessageCircle, Plug, Plus, ShieldCheck, Smartphone } from "lucide-react";
import { Button } from "../../../ui/kit";
import ChannelDrawer, { type ConnectionTools } from "./channel-drawer";
import { CHANNEL_CATALOG } from "@/channels/catalog.js";

/** One icon per catalogue entry, kept here because the catalogue itself is server-shared. */
const ICONS: Record<string, ReactNode> = {
  google: <ShieldCheck />,
  whatsapp: <MessageCircle />,
  sms: <Smartphone />,
  other: <Plug />,
};

/**
 * The channel list and the channel picker, as one thing.
 *
 * They used to be two: a table of what was connected, and a drawer that opened on a grid
 * of what could be. So the page answered "what have I got" and hid "what could I have"
 * behind a button, and the same three channels were drawn twice in two different shapes.
 *
 * Here every channel in the catalogue is a card, connected or not. A connected one shows
 * what it is sending as and what it has spent, and both are editable in place. One that is
 * not shows what it would take to connect it, and clicking it opens that. Nothing about
 * adding or editing changed underneath — only where the choice is made.
 */
export default function ChannelCards({
  productId,
  connections,
  connected,
  other,
  googleReady,
  sesReady,
  mailboxes,
  smtpAction,
  mcpAction,
  httpAction,
  googleAction,
  sesAction,
}: {
  productId: string;
  connections: ConnectionTools[];
  /**
   * Server-rendered rows per catalogue id: the live values, with Edit and Remove already
   * bound to their actions. Rendered on the server because usage and limits are read from
   * the database, and passed through as nodes so this component stays a shell.
   */
  connected: Record<string, ReactNode[]>;
  /** Channels on a key the catalogue does not carry — nothing is hidden because of it. */
  other?: ReactNode[];
  googleReady: boolean;
  sesReady: boolean;
  /** Google mailboxes that could read an SES channel's replies, and whether each actually
   * has the read permission. */
  mailboxes: Array<{ id: string; email: string; canRead: boolean }>;
  smtpAction: (formData: FormData) => void | Promise<void>;
  mcpAction: (formData: FormData) => void | Promise<void>;
  httpAction: (formData: FormData) => void | Promise<void>;
  googleAction: (formData: FormData) => void | Promise<void>;
  sesAction: (formData: FormData) => void | Promise<void>;
}) {
  // Which card is being connected, or nothing. Keyed remount below resets the transport
  // choice per channel, so opening SMS never shows the tab Gmail was left on.
  const [picking, setPicking] = useState<string | null>(null);

  return (
    <>
      <div className="channels">
        {CHANNEL_CATALOG.map((option) => {
          const rows = connected[option.id] ?? [];
          const live = rows.length > 0;

          const head = (
            <span className="channel-head">
              {ICONS[option.id]}
              <strong>{option.label}</strong>
              {live ? (
                <span className="pill ok">Connected</span>
              ) : option.status === "soon" ? (
                <span className="pill">Soon</span>
              ) : null}
            </span>
          );

          // Nothing connected: the whole card is the button. A card that opens a form only
          // when a small control at its edge is hit reads as broken to everyone who clicked
          // the card itself first.
          if (!live) {
            return (
              <button
                key={option.id}
                type="button"
                className="channel-card"
                onClick={() => setPicking(option.id)}
              >
                {head}
                <p className="blurb">
                  {option.status === "soon" && option.waitingOn ? option.waitingOn : option.blurb}
                </p>
                <span className="channel-cta">
                  {option.status === "soon" ? "Connect your own provider" : `Connect ${option.label}`}
                </span>
              </button>
            );
          }

          return (
            <div key={option.id} className="channel-card">
              {head}
              {rows}
              <div className="channel-foot">
                <Button variant="quiet" size="sm" icon={<Plus />} onClick={() => setPicking(option.id)}>
                  Connect another
                </Button>
              </div>
            </div>
          );
        })}

        {other && other.length > 0 && (
          <div className="channel-card">
            <span className="channel-head">
              {ICONS.other}
              <strong>Other</strong>
              <span className="pill ok">Connected</span>
            </span>
            <p className="blurb">
              On a key the catalogue does not list — in-app or push, or a channel created before the
              catalogue existed. Editable here like any other.
            </p>
            {other}
          </div>
        )}
      </div>

      {/* Remounted per channel so each opens on its own best transport rather than on
          whichever tab the previous card was left on. */}
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
          googleAction={googleAction}
          sesAction={sesAction}
        />
      )}
    </>
  );
}
