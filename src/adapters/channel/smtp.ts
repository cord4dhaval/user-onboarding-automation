import nodemailer, { type Transporter } from "nodemailer";
import type { ChannelAdapter, OutboundMessage, SendResult } from "./types.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Native SMTP. Useful for a real end-to-end test before any MCP send tool exists, and a
 * legitimate production path for a tenant who brings their own mail server.
 */
export class SmtpAdapter implements ChannelAdapter {
  readonly key = "email";
  private transport: Transporter;

  constructor(config: SmtpConfig, private readonly defaultFrom: string) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: message.from ?? this.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.bodyText,
      html: message.bodyHtml,
      replyTo: message.replyTo,
    });
    // SMTP hands off synchronously; the relay accepting it is all the confirmation there is.
    return { accepted: true, providerMessageId: info.messageId, disposition: "sent" };
  }
}
