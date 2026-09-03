import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";
import { grantedCapabilities } from "../auth/google.js";
import { GmailAdapter } from "../adapters/channel/gmail.js";
import { pollReplies } from "../engine/inbound.js";

/**
 * Proves a connected Gmail mailbox actually works, without waiting for a campaign to try
 * it at 3am.
 *
 * Every step is the same code the engine runs: the broker refreshes the token, the adapter
 * builds the MIME, the poller reads the mailbox. A dry check that used its own shortcuts
 * would pass on a channel that cannot send.
 *
 *   npm run gmail:check
 *   npm run gmail:check -- you@example.com     # also sends one real message
 */

const target = process.argv.find((a) => a.includes("@"));
const line = (label: string, value: string) => console.log(`  ${label.padEnd(22)} ${value}`);

async function main() {
  const db = await getDb();
  const connections = await db
    .collection(C.connections)
    .find({ authType: "oauth2", provider: "google" })
    .toArray();

  if (connections.length === 0) {
    console.log("\nNo Gmail connection. Channels page → Add channel → Gmail.\n");
    return;
  }

  for (const connection of connections) {
    const scopes = (connection.scopes ?? []) as string[];
    const caps = grantedCapabilities(scopes);
    console.log(`\n── ${String(connection.accountEmail ?? connection._id)} ──`);
    line("status", String(connection.status));
    line("granted", `send ${caps.send ? "yes" : "no"} · read ${caps.read ? "yes" : "no"} · aliases ${caps.manage ? "yes" : "no"}`);
    if (Array.isArray(connection.sendAs) && connection.sendAs.length > 0) {
      line("send-as", (connection.sendAs as string[]).join(", "));
    }

    // Goes through the broker, so this also exercises the refresh path — which is the part
    // that silently breaks and takes a channel down an hour later.
    let token: string;
    try {
      token = await resolveSecret(String(connection.orgId), String(connection._id), "script.gmail-check");
      line("token", "resolved (refreshed if it was near expiry)");
    } catch (err) {
      line("token", `FAILED — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!profile.ok) {
      line("gmail", `FAILED ${profile.status} — ${(await profile.text()).slice(0, 200)}`);
      continue;
    }
    const info = (await profile.json()) as { emailAddress?: string; messagesTotal?: number };
    line("gmail", `${info.emailAddress} · ${info.messagesTotal ?? "?"} messages`);

    const channel = await db
      .collection(C.channels)
      .findOne({ connectionId: String(connection._id) });
    if (channel) {
      const gov = channel.governor as { dailyCap: number; perMinute?: number; perHour?: number };
      line("channel", `${String(channel.key)} · from ${String(channel.from)} · ${channel.enabled ? "enabled" : "disabled"}`);
      line("limits", `${gov.perMinute ?? "—"}/min · ${gov.perHour ?? "—"}/hr · ${gov.dailyCap}/day`);
    } else {
      line("channel", "MISSING — the connect flow should have created one");
    }

    if (target && channel) {
      const adapter = new GmailAdapter("email", token, String(channel.from));
      const result = await adapter.send({
        to: target,
        subject: "Gmail channel check",
        bodyText: "Sent through the Gmail API by gmail:check. Nothing to action.",
        bodyHtml: "<p>Sent through the Gmail API by <code>gmail:check</code>. Nothing to action.</p>",
      });
      line("send", `${result.disposition} · id ${result.providerMessageId ?? "—"}`);
    }

    if (caps.read && channel) {
      const summary = await pollReplies(String(connection.orgId), String(channel.productId), 10);
      line(
        "inbound",
        `${summary.mailboxes} mailbox(es) · examined ${summary.examined} · replies ${summary.recorded} · bounces ${summary.bounced}`,
      );
      for (const err of summary.errors) line("inbound error", err);
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
