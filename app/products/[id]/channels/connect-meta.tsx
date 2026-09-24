"use client";

import { MessageCircle } from "lucide-react";

/**
 * Starts an Embedded Signup by going to it.
 *
 * This was Meta's JavaScript SDK first, opening the flow in a popup so nobody left the page.
 * It is a link now. The SDK fires a federated-login probe of its own the moment it
 * initialises — `scope=openid`, `dialog_source=fedcm`, redirecting to the site root — and
 * that probe is blocked unless the root is registered as an OAuth redirect. The failure
 * looks exactly like the signup flow being misconfigured, on a screen naming redirect URIs,
 * and it happens before any of our code runs.
 *
 * A link has no such probe, no popup to be blocked, and no script to load. Meta redirects
 * back to our callback, which is where the connection is written either way.
 */
export default function ConnectMeta({ href }: { href: string }) {
  return (
    <a className="button primary" href={href}>
      <MessageCircle />
      Connect WhatsApp
    </a>
  );
}
