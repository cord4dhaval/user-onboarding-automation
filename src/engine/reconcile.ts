import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveChannelAdapter } from "./adapters.js";

export interface ReconcileSummary {
  checked: number;
  confirmed: number;
  failed: number;
  stillPending: number;
}

/**
 * Reconciles asynchronously-delivered messages. A provider that queues can only tell us
 * the real outcome later, so an action sits at "dispatched" until this confirms it.
 *
 * Without this the system would report a send that a queue later dropped, and every
 * downstream number — temperature, calibration, funnel — would be built on it.
 */
export async function reconcileDispatched(
  orgId: string,
  productId: string,
  limit = 100,
): Promise<ReconcileSummary> {
  const db = await getDb();
  const summary: ReconcileSummary = { checked: 0, confirmed: 0, failed: 0, stillPending: 0 };

  const pending = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "dispatched", providerMessageId: { $exists: true } })
    .limit(limit)
    .toArray();

  for (const action of pending) {
    summary.checked++;
    try {
      const adapter = await resolveChannelAdapter(orgId, String(action.channelId));
      if (!adapter.checkStatus) {
        // The channel turned out to be synchronous after all; trust the send.
        await db.collection(C.actions).updateOne({ _id: action._id }, { $set: { status: "sent" } });
        summary.confirmed++;
        continue;
      }

      const status = await adapter.checkStatus(String(action.providerMessageId));
      if (status === "sent") {
        await db
          .collection(C.actions)
          .updateOne({ _id: action._id }, { $set: { status: "sent", confirmedAt: new Date() } });
        summary.confirmed++;
      } else if (status === "failed") {
        // Refund the touch: the goal's budget should only be spent on messages that landed.
        await db
          .collection(C.actions)
          .updateOne({ _id: action._id }, { $set: { status: "failed", error: "provider reported failed" } });
        await db
          .collection(C.goalInstances)
          .updateOne({ _id: action.goalInstanceId }, { $inc: { "spent.touches": -1 } });
        summary.failed++;
      } else {
        summary.stillPending++;
      }
    } catch {
      summary.stillPending++;
    }
  }

  return summary;
}
