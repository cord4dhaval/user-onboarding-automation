import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";
import { McpClient } from "../mcp/client.js";
import type { Binding } from "../mcp/binding.js";
import { McpChannelAdapter } from "../adapters/channel/mcp.js";
import { SmtpAdapter } from "../adapters/channel/smtp.js";
import type { ChannelAdapter } from "../adapters/channel/types.js";

/**
 * Resolves the adapter for a channel from its connection. The engine calls this at send
 * time; the secret is fetched here and never travels further than this process.
 */
export async function resolveChannelAdapter(orgId: string, channelId: string): Promise<ChannelAdapter> {
  const db = await getDb();
  const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId), orgId });
  if (!channel) throw new Error(`channel ${channelId} not found`);

  const connectionId = String(channel.connectionId);
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection) throw new Error(`connection ${connectionId} not found`);

  const secret = await resolveSecret(orgId, connectionId, "engine.send");

  if (connection.authType === "smtp") {
    const cfg = connection.smtp as { host: string; port: number; user: string } | undefined;
    if (!cfg) throw new Error("SMTP connection is missing its host configuration");
    return new SmtpAdapter(
      { host: cfg.host, port: cfg.port, secure: cfg.port === 465, user: cfg.user, pass: secret },
      String(channel.from ?? cfg.user),
    );
  }

  const binding = await db.collection(C.mcpBindings).findOne({ orgId, connectionId });
  if (!binding?.bind || !(binding.bind as Record<string, unknown>).send) {
    throw new Error("this connection has no send tool bound");
  }
  const client = new McpClient(String(connection.serverUrl), secret);
  // A bound status verb means the provider queues rather than delivers, so sends must be
  // reconciled afterwards instead of being trusted on the call.
  const asyncDelivery = Boolean((binding.bind as Record<string, unknown>).send_status);
  return new McpChannelAdapter(String(channel.key), client, binding.bind as Binding, asyncDelivery);
}
