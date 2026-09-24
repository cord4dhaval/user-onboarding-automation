import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveChannelAdapter } from "./adapters.js";
import { noteEvent, sentNote } from "./crm/writeBack.js";

export interface ReconcileSummary {
  checked: number;
  confirmed: number;
  failed: number;
  stillPending: number;
}

/** The note for a message a provider has just confirmed it sent. Keyed on the action, so the send path and this one can never both write it. */
async function noteSend(action: Document): Promise<void> {
  const content = (action.content ?? {}) as { subject?: string; slotText?: string; bodyMd?: string };
  const note = sentNote({
    channel: String(action.channel),
    op: action.op ? String(action.op) : undefined,
    subject: content.subject,
    text: content.slotText || content.bodyMd,
  });
  if (!note) return;
  const db = await getDb();
  const instance = await db
    .collection(C.goalInstances)
    .findOne({ _id: new ObjectId(String(action.goalInstanceId)) }, { projection: { goalKey: 1 } });
  await noteEvent({
    orgId: String(action.orgId),
    productId: String(action.productId),
    personId: String(action.personId),
    campaignKey: instance?.goalKey ? String(instance.goalKey) : undefined,
    event: note.event,
    body: note.body,
    key: String(action._id),
  }).catch(() => false);
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
        await noteSend(action);
        summary.confirmed++;
        continue;
      }

      // Refund the touch: the goal's budget should only be spent on messages that landed.
      // goalInstanceId is stored as a string, so it is matched as the ObjectId it names.
      const refund = () =>
        db
          .collection(C.goalInstances)
          .updateOne({ _id: new ObjectId(String(action.goalInstanceId)) }, { $inc: { "spent.touches": -1 } });

      // A call is kept whole on the action — who answered, for how long, what was said —
      // because that is what the next run reads to decide what happens to this lead.
      if (adapter.callResult) {
        const call = await adapter.callResult(String(action.providerMessageId));
        if (!call.done) {
          summary.stillPending++;
          continue;
        }
        const record = { ...call, endedAt: call.endedAt ?? new Date() };
        if (call.connected) {
          await db
            .collection(C.actions)
            .updateOne({ _id: action._id }, { $set: { status: "sent", confirmedAt: record.endedAt, call: record } });
          summary.confirmed++;
        } else {
          await db.collection(C.actions).updateOne(
            { _id: action._id },
            { $set: { status: "failed", error: `call ${call.status.replace(/-/g, " ")}`, call: record } },
          );
          await refund();
          summary.failed++;
        }
        continue;
      }

      const status = await adapter.checkStatus(String(action.providerMessageId));
      if (status === "sent") {
        await db
          .collection(C.actions)
          .updateOne({ _id: action._id }, { $set: { status: "sent", confirmedAt: new Date() } });
        // Only now is it true that we wrote to them, so only now does their CRM hear it. A
        // message that queues with the provider is told to the sales team once, here, and
        // never at the moment it was handed over.
        await noteSend(action);
        summary.confirmed++;
      } else if (status === "failed") {
        await db
          .collection(C.actions)
          .updateOne({ _id: action._id }, { $set: { status: "failed", error: "provider reported failed" } });
        await refund();
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
