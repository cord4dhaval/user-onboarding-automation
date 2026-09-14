import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveChannelAdapter } from "./adapters.js";
import { appOrigin } from "./vars.js";

/**
 * A plain mail to the person who owns this product, sent through the product's own
 * mailbox, for the one signal that expires: a reply.
 *
 * The bell in the app already knows. The bell is only seen by somebody looking at the
 * app, and a reply at ten past the hour otherwise waits for the routine at half past —
 * an answer the same hour is a conversation, the same week is an apology. This lands in
 * the owner's inbox the same minute, so a human can write back before any routine runs.
 *
 * Off unless OWNER_NOTIFY_EMAIL is set. Never throws: a ping that fails must not stop
 * the reply from being recorded.
 */
export function ownerNotifyAddress(): string | null {
  const value = (process.env.OWNER_NOTIFY_EMAIL ?? "").trim();
  return value.includes("@") ? value : null;
}

export interface OwnerMail {
  subject: string;
  lines: string[];
  /** App path the mail links to, such as the lead's page. */
  href?: string;
}

export async function mailOwner(orgId: string, productId: string, input: OwnerMail): Promise<boolean> {
  const to = ownerNotifyAddress();
  if (!to) return false;
  try {
    const db = await getDb();
    const channel = await db
      .collection(C.channels)
      .findOne({ orgId, productId, key: "email", enabled: true, status: "healthy" }, { projection: { _id: 1 } });
    if (!channel) return false;
    const adapter = await resolveChannelAdapter(orgId, String(channel._id));
    const link = input.href ? `${appOrigin()}${input.href}` : null;
    const bodyText = [...input.lines, ...(link ? ["", `Open the lead: ${link}`] : [])].join("\n");
    await adapter.send({ to, subject: input.subject, bodyText });
    return true;
  } catch (err) {
    console.error("owner mail failed", err instanceof Error ? err.message : err);
    return false;
  }
}
