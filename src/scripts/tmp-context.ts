import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { mailSceneWords, planPriceFigures, priceHistory, theirWords } from "../engine/rolling.js";

async function main(): Promise<void> {
  const db = await getDb();
  const product = await db.collection(C.products).findOne({ _id: new ObjectId("6a964454c4fa12977b6d6964") }, { projection: { config: 1 } });
  const prices = planPriceFigures(((product?.config as { writing?: { facts?: unknown } }).writing ?? {}).facts);
  const instances = await db.collection(C.goalInstances).find({ goalKey: "teamgrid_leads_v3" }).toArray();
  const ids = instances.map((i) => String(i._id));
  const pending = await db.collection(C.actions).find({ goalInstanceId: { $in: ids }, status: "awaiting_approval", sceneKind: { $exists: false } }).toArray();
  console.log(`${pending.length} old-style mails waiting in Review\n`);
  for (const a of pending) {
    const inst = instances.find((i) => String(i._id) === String(a.goalInstanceId))!;
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(inst.personId)) });
    const plan = inst.currentPlanId ? await db.collection(C.plans).findOne({ _id: new ObjectId(String(inst.currentPlanId)) }) : null;
    const step = ((plan?.steps ?? []) as Array<Record<string, unknown>>).find((s) => Number(s.id) === Number(a.planStepId));
    const prior = await db.collection(C.actions).find({ goalInstanceId: String(a.goalInstanceId), status: { $in: ["sent", "dispatched"] } }).sort({ sentAt: 1 }).toArray();
    const price = priceHistory(prior, prices);
    const form = (person?.enrichment as { form?: Record<string, unknown> } | undefined)?.form ?? {};
    console.log(`--- ${String(a._id)}`);
    console.log(`name=${String(person?.firstName ?? "")} | team=${String(form.team_size ?? "?")} | problem=${String(form.main_problem ?? "-").slice(0, 70)} | domain=${String(person?.companyDomain ?? "-")}`);
    console.log(`site=${String((person?.enrichment as { siteText?: unknown } | undefined)?.siteText ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    console.log(`theirs=${theirWords(person).slice(0, 12).join(",")}`);
    console.log(`step=${String(step?.hook ?? "-")} | theme=${String(step?.theme ?? "-").slice(0, 80)} | ideas=${JSON.stringify(step?.idea_refs ?? [])}`);
    console.log(`price_due=${price.due} (last given ${price.mails_ago ?? "never"} mails ago) | sends=${prior.length} | format=${String(a.format ?? "-")}`);
    console.log(`NOW subject="${String((a.content as { subject?: unknown }).subject ?? "")}" body="${String((a.content as { slotText?: unknown }).slotText ?? "").replace(/\s+/g, " ").slice(0, 150)}"`);
    const sentences = prior.flatMap((p) => mailSceneWords(p).split(/(?<=[.!?])\s+|\n+/)).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 6);
    console.log(`said_before=${JSON.stringify(sentences.slice(-6).map((x) => x.replace(/\*\*/g, "").slice(0, 70)))}`);
  }
}
void main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
