import type { ChannelAdapter, OutboundMessage, SendResult } from "./types.js";

/** Dry-run sink. Renders exactly what would go out, without touching a provider. */
export class ConsoleAdapter implements ChannelAdapter {
  readonly key = "console";

  async send(message: OutboundMessage): Promise<SendResult> {
    const rule = "─".repeat(64);
    console.log(`\n${rule}`);
    console.log(`To:      ${message.to}`);
    if (message.from) console.log(`From:    ${message.from}`);
    if (message.subject) console.log(`Subject: ${message.subject}`);
    console.log(rule);
    console.log(message.bodyText);
    console.log(`${rule}\n`);
    return { accepted: true, providerMessageId: `dryrun-${Date.now()}`, disposition: "sent" };
  }
}
