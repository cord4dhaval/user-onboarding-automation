"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";

/**
 * Pastes a fresh LinkedIn session onto a connected account, in place.
 *
 * A LinkedIn session ends when the account logs out, changes its password, or LinkedIn asks
 * it to sign in again, and the only cure is a new session from a browser. The row's Edit
 * drawer holds limits and labels, not the session, so without this the only way in was
 * "Connect another" in the group header, which reads as adding a second account.
 *
 * It posts to the same action as the connect drawer. The session is matched to the account
 * by LinkedIn's member id, so the same account (renamed or not) replaces its old session and
 * keeps its channel, its queue and its history; a different account is added beside it.
 */
export default function ReconnectLinkedIn({
  productId,
  account,
  action,
  urgent,
}: {
  productId: string;
  /** The account's name as last read from LinkedIn. */
  account: string;
  /** createLinkedInChannel. */
  action: (formData: FormData) => void | Promise<void>;
  /** The session is known to be dead, so this is the fix rather than an option. */
  urgent: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant={urgent ? "primary" : "ghost"} size="sm" icon={<ShieldCheck />} onClick={() => setOpen(true)}>
        Reconnect
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Reconnect LinkedIn"
        description={`Paste a fresh session for ${account || "this account"}. It replaces the old one; the invites and messages waiting on it stay.`}
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />
          <p className="sub tight">
            In a browser logged in to LinkedIn as this account: F12 → Application → Cookies →{" "}
            <code>https://www.linkedin.com</code>. Copy <code>li_at</code> and <code>JSESSIONID</code> (keep its
            quotes). Then F12 → Network → any request → copy the <code>user-agent</code> header.
          </p>
          <p className="sub tight">
            Logged in as a different account? It is added as a second LinkedIn sender instead, and this one stays
            as it is.
          </p>
          <label>
            li_at cookie
            <input name="li_at" placeholder="AQEDAT…" required autoComplete="off" />
          </label>
          <label>
            JSESSIONID cookie
            <input name="jsessionid" placeholder={'"ajax:1234567890"'} required autoComplete="off" />
          </label>
          <label>
            Browser user agent
            <input name="userAgent" placeholder="Mozilla/5.0 (Macintosh…) Chrome/…" required autoComplete="off" />
          </label>
          <label className="check">
            <input type="checkbox" name="consent" />
            <span>
              I understand this acts as my LinkedIn account and may put it at risk, and I am connecting an account I
              control.
            </span>
          </label>
          <SubmitButton pendingLabel="Checking the session…">Reconnect</SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
