import { ObjectId, type Document } from "mongodb";
import { resolveSecret } from "../crypto/broker.js";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { applyWhatsAppEvent } from "./whatsappInbound.js";

export interface WhatsAppReportSummary {
  unconfirmed: number;
  checked: number;
  delivered: number;
  read: number;
  failed: number;
  errors: string[];
}

/** Long enough for WATI's own webhook to have arrived, if it was ever going to. */
const QUIET_MS = 30 * 60_000;
/** Meta settles a message within minutes; after three days an unknown status stays unknown. */
const LOOKBACK_MS = 3 * 86_400_000;
/** One report read per connection per quarter hour. Each read is a request per broadcast. */
const EVERY_MS = 15 * 60_000;

const WATI_REPORT_STATUS: Record<string, "delivered" | "read" | "failed"> = {
  delivered: "delivered",
  read: "read",
  clicked: "read",
  replied: "read",
  failed: "failed",
};

/**
 * What became of WhatsApp messages the webhook never reported on, read from WATI's own
 * broadcast report.
 *
 * WATI accepts a template send and only learns afterwards whether Meta delivered it. The
 * webhook is the only way that answer reached us, so a webhook that was never set up — or
 * one that stops — left every blocked message saying "sent": four people Meta held back on
 * 18 and 20 September were shown as reached, and the next step was queued behind them.
 *
 * Each engine send is its own one-recipient broadcast, so only broadcasts created close to
 * an unconfirmed send are opened.
 */
export async function pollWhatsAppReport(orgId: string, productId: string, now = new Date()): Promise<WhatsAppReportSummary> {
  const db = await getDb();
  const summary: WhatsAppReportSummary = { unconfirmed: 0, checked: 0, delivered: 0, read: 0, failed: 0, errors: [] };

  const pending = await db
    .collection(C.actions)
    .find({
      orgId,
      productId,
      channel: "whatsapp",
      status: "sent",
      providerMessageId: { $exists: true },
      sentAt: { $gte: new Date(now.getTime() - LOOKBACK_MS), $lte: new Date(now.getTime() - QUIET_MS) },
      $or: [{ delivery: { $exists: false } }, { "delivery.status": "sent" }],
    })
    .project({ channelId: 1, providerMessageId: 1, sentAt: 1 })
    .toArray();
  summary.unconfirmed = pending.length;
  if (pending.length === 0) return summary;

  const byChannel = new Map<string, Document[]>();
  for (const action of pending) {
    const key = String(action.channelId);
    byChannel.set(key, [...(byChannel.get(key) ?? []), action]);
  }

  for (const [channelId, actions] of byChannel) {
    try {
      const channel = ObjectId.isValid(channelId) ? await db.collection(C.channels).findOne({ _id: new ObjectId(channelId) }) : null;
      const connection = channel?.connectionId
        ? await db.collection(C.connections).findOne({ _id: new ObjectId(String(channel.connectionId)) })
        : null;
      if (!connection || connection.provider !== "wati") continue;
      const last = connection.whatsappReportAt as Date | undefined;
      if (last && now.getTime() - new Date(last).getTime() < EVERY_MS) continue;
      await db.collection(C.connections).updateOne({ _id: connection._id }, { $set: { whatsappReportAt: now } });

      const endpoint = String((connection.http as { endpointUrl?: string } | undefined)?.endpointUrl ?? connection.endpointUrl ?? "");
      const base = `${new URL(endpoint).origin}/api/ext/v3`;
      const token = await resolveSecret(orgId, String(connection._id), "engine.whatsapp_report");
      const get = async (path: string) => {
        const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`WATI ${path.split("?")[0]} answered HTTP ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      };

      const wanted = new Set(actions.map((a) => String(a.providerMessageId)));
      const sentTimes = actions.map((a) => new Date(a.sentAt as Date).getTime());
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const from = day(Math.min(...sentTimes) - 86_400_000);
      const to = day(now.getTime() + 86_400_000);

      const broadcasts: Array<{ id?: string; created?: string }> = [];
      for (let page = 1; page <= 10; page++) {
        const body = await get(`/broadcasts?date_from=${from}&date_to=${to}&page_size=100&page_number=${page}`);
        const list = (body.broadcasts ?? []) as typeof broadcasts;
        broadcasts.push(...list);
        if (list.length < 100) break;
      }

      // A broadcast is created the moment its send is made, so one more than ten minutes
      // from every unconfirmed send cannot hold any of them.
      const near = broadcasts.filter((b) => {
        const at = b.created ? new Date(b.created).getTime() : NaN;
        return Number.isFinite(at) && sentTimes.some((t) => Math.abs(t - at) < 10 * 60_000);
      });

      for (const broadcast of near) {
        if (wanted.size === 0) break;
        const body = await get(`/broadcasts/${broadcast.id}/recipients?page_size=100`);
        for (const recipient of (body.recipients ?? []) as Array<Record<string, unknown>>) {
          const ref = String(recipient.local_message_id ?? "");
          const status = WATI_REPORT_STATUS[String(recipient.status ?? "")];
          if (!wanted.has(ref) || !status) continue;
          wanted.delete(ref);
          summary.checked++;
          const done = await applyWhatsAppEvent(
            { orgId, productId },
            {
              kind: "status",
              ref,
              status,
              ...(recipient.failed_code ? { code: String(recipient.failed_code) } : {}),
              at: recipient.created ? new Date(String(recipient.created)) : now,
              source: "WATI broadcast report",
            },
          );
          if (done.startsWith("marked")) summary[status]++;
        }
      }
    } catch (err) {
      summary.errors.push(`channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
