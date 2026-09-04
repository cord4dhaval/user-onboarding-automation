import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { grantedCapabilities } from "../auth/google.js";

/**
 * What this product is able to hear.
 *
 * A count of zero has two meanings and the console was printing only one of them. This
 * product has sent a hundred and fifty messages and recorded no replies, and the reason is
 * not that nobody wrote back: the email channel is an MCP server with no inbound tool and
 * no Google mailbox attached, so `pollReplies` finds no mailbox to read and returns before
 * it examines anything. Every reply ever sent to that campaign is sitting in a mailbox
 * nothing in this system can open.
 *
 * "0 replied" claims a measurement. "Replies are not being read" states a fact and points
 * at the fix, and the two must never render the same way.
 */
export interface Reach {
  /** A mailbox this product can actually poll — natively, or through an MCP tool. */
  replies: boolean;
  /** Why not, in the words the console shows when it is false. */
  why?: string;
}

export async function replyReach(orgId: string, productId: string): Promise<Reach> {
  const db = await getDb();
  const channels = await db.collection(C.channels).find({ orgId, productId, enabled: true }).toArray();
  if (channels.length === 0) return { replies: false, why: "no channel is connected" };

  for (const channel of channels) {
    if (!channel.connectionId) continue;
    const connection = await db
      .collection(C.connections)
      .findOne({ _id: new ObjectId(String(channel.connectionId)) });
    if (!connection) continue;

    // The native path: our own token, granted by the customer on Google's screen.
    if (
      connection.authType === "oauth2" &&
      connection.provider === "google" &&
      grantedCapabilities((connection.scopes ?? []) as string[]).read
    ) {
      return { replies: true };
    }

    // The borrowed path, kept for products connected before native Google existed. It only
    // works if the server actually offers the tool that hands out mailbox tokens.
    const binding = await db
      .collection(C.mcpBindings)
      .findOne({ orgId, connectionId: String(connection._id) });
    const tools = ((binding?.discoveredTools ?? []) as Array<{ name?: unknown }>).map((t) => String(t.name));
    if (tools.includes("get_email_tokens")) return { replies: true };
  }

  return {
    replies: false,
    why: "no mailbox is connected, so nothing reads what people write back",
  };
}
