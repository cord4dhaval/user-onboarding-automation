import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ensureIndexes } from "../db/indexes.js";
import { reverifyConnection } from "../mcp/reverify.js";
import { crmMap } from "../schemas/crm.js";
import { CrmClient, RateLimited } from "../engine/crm/client.js";
import { proposeCrmMap } from "../engine/crm/map.js";
import {
  checkUnchecked,
  hottestFirst,
  lockConnection,
  peopleInGoal,
  syncChanges,
  syncPerson,
  unlockConnection,
} from "../engine/crm/sync.js";

/**
 * Sets up and runs CRM reading for one connection from a terminal.
 *
 * The minute tick does the same work a few calls at a time; this is for the first fill,
 * where waiting hours for the tick to walk four hundred people is the wrong trade. It takes
 * the same lock the tick does, so the two never read the same feed at once.
 *
 *   npm run crm:sync -- --connection <id> --propose --scope '{"orgId":"…"}' --projects a,b
 *   npm run crm:sync -- --connection <id> --person <personId>
 *   npm run crm:sync -- --connection <id> --backfill --goal teamgrid_leads_v3   (not looked up yet)
 *   npm run crm:sync -- --connection <id> --refresh --goal teamgrid_leads_v3    (everyone, read again)
 *   npm run crm:sync -- --connection <id> --changes
 *   npm run crm:sync -- --connection <id> --enable | --disable
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const connectionId = arg("connection");
  if (!connectionId || !ObjectId.isValid(connectionId)) throw new Error("--connection <id> is required");
  const db = await getDb();
  await ensureIndexes();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection) throw new Error(`no connection ${connectionId}`);
  const orgId = String(connection.orgId);

  if (flag("propose")) {
    const found = await reverifyConnection(orgId, connectionId);
    if (found.error) throw new Error(found.error);
    const scope = arg("scope") ? (JSON.parse(String(arg("scope"))) as Record<string, unknown>) : {};
    const map = proposeCrmMap(found.tools, scope);
    if (!map) throw new Error("these tools do not look like a CRM: no find tool and no history tool");
    const projects = (arg("projects") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const saved = crmMap.parse({ ...map, projects });
    await db
      .collection(C.connections)
      .updateOne({ _id: connection._id }, { $set: { "crm.map": saved, "crm.proposedAt": new Date() } });
    console.log(JSON.stringify(saved, null, 1));
  }

  if (flag("enable") || flag("disable")) {
    const enabled = flag("enable");
    await db.collection(C.connections).updateOne(
      { _id: connection._id },
      { $set: { "crm.enabled": enabled, [enabled ? "crm.enabledAt" : "crm.disabledAt"]: new Date() } },
    );
    console.log(`CRM reading ${enabled ? "on" : "off"}`);
  }

  const person = arg("person");
  const goal = arg("goal");
  const work = person || flag("backfill") || flag("refresh") || flag("changes");
  if (!work) return;
  if ((flag("backfill") || flag("refresh")) && !goal) {
    throw new Error("--backfill and --refresh walk one campaign at a time: pass --goal <key>");
  }

  if (!(await lockConnection(connectionId, 60 * 60_000))) throw new Error("another CRM run holds this connection; try again shortly");
  try {
    const client = await CrmClient.open(connectionId, { retries: 2 });
    const productId = String(connection.productId);
    const until = Date.now() + Number(arg("minutes") ?? 60) * 60_000;

    /** Runs one unit of CRM work, waiting out a rate limit instead of giving up on it. */
    const patiently = async <T>(work: () => Promise<T>): Promise<T> => {
      for (;;) {
        try {
          return await work();
        } catch (err) {
          if (!(err instanceof RateLimited)) throw err;
          // The limit is shared with the product's own mail, so back right off and resume.
          console.log(`${new Date().toISOString()} rate limited; waiting 3 minutes`);
          await new Promise((r) => setTimeout(r, 180_000));
        }
      }
    };

    if (person) console.log("person", person, await patiently(() => syncPerson(client, person)));
    if (flag("changes")) console.log("changes", await patiently(() => syncChanges(client, Date.now() + 5 * 60_000)));

    if (flag("backfill") && goal) {
      // Only the people in this campaign nobody has looked up yet, hottest first.
      let total = 0;
      while (Date.now() < until) {
        const done = await patiently(() => checkUnchecked(client, Math.min(until, Date.now() + 60_000), { goalKey: goal }));
        total += done;
        console.log(`${new Date().toISOString()} looked up ${total} · ${client.calls} calls`);
        if (!done) break;
      }
    }

    if (flag("refresh") && goal) {
      // Everyone in the campaign read again in full, hottest first — for a campaign whose
      // copy should be current now rather than whenever the change feed next names them.
      const ids = await hottestFirst(orgId, productId, { _id: { $in: await peopleInGoal(orgId, productId, goal) } }, 5_000);
      console.log(`${goal}: ${ids.length} people, hottest first`);
      let n = 0;
      for (const id of ids) {
        if (Date.now() > until) break;
        const res = await patiently(() => syncPerson(client, id));
        n++;
        console.log(`${new Date().toISOString()} ${n}/${ids.length} ${id} records=${res.records} new_rows=${res.added} · ${client.calls} calls`);
      }
    }
    const links = await db.collection(C.crmLinks).aggregate([
      { $match: { orgId, connectionId } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]).toArray();
    const rows = await db.collection(C.crmActivity).countDocuments({ orgId, connectionId });
    console.log("links", Object.fromEntries(links.map((l) => [l._id, l.n])), "activity rows", rows, "calls", client.calls);
  } finally {
    await unlockConnection(connectionId);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
