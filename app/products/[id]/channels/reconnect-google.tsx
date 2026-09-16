"use client";

import { ShieldCheck } from "lucide-react";
import { SubmitButton } from "../../../ui/kit";

/**
 * Signs a Gmail channel in again, in place.
 *
 * A Google grant does not last forever — it ends when the account revokes it, and on an
 * OAuth app still in testing it ends on its own after a week. When that happens the only
 * cure is a human back on the consent screen, and until now this page did not offer one:
 * Gmail connections are hidden from the Connections page, which is where every other
 * reconnect lives, so the card here showed a dead mailbox with nothing but Edit and Remove.
 *
 * The address travels as the login hint, so Google opens on the mailbox that broke instead
 * of on a chooser where picking the wrong account creates a second channel. Signing in as
 * the same address is a reconnect: the callback moves this channel onto the new credential
 * and keeps its history, its caps and its name.
 */
export default function ReconnectGoogle({
  productId,
  email,
  action,
  urgent,
}: {
  productId: string;
  /** The mailbox to pre-select. Absent only for a channel connected before addresses were stored. */
  email?: string;
  /** startGoogleOAuth — the same action the connect drawer posts to. */
  action: (formData: FormData) => void | Promise<void>;
  /** The mailbox is refusing to send, so this is the fix rather than an option. */
  urgent: boolean;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="productId" value={productId} />
      {email ? <input type="hidden" name="loginHint" value={email} /> : null}
      <SubmitButton
        variant={urgent ? "primary" : "ghost"}
        size="sm"
        icon={<ShieldCheck />}
        pendingLabel="Opening Google…"
      >
        Reconnect
      </SubmitButton>
    </form>
  );
}
