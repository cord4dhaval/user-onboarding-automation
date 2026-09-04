import { MongoClient, ObjectId } from "mongodb";
import { writeFileSync } from "node:fs";

const OUT =
  "/private/tmp/claude-502/-Users-amitg-Dhaval-react-temgrid-onboarding/c61359df-d87d-40ca-83a2-2cb79994c646/scratchpad";

const c = new MongoClient(process.env.MONGODB_URI!);
await c.connect();
const db = c.db("conversion_engine");

const BINDING = new ObjectId("6a957101b4793622de23c73a");
const SOURCE = new ObjectId("6a994a34b4793622de24286c");

// Rollback copy first — both edits are one-field, restorable from this file.
const before = await db.collection("mcp_bindings").findOne({ _id: BINDING });
const src0 = await db.collection("sources").findOne({ _id: SOURCE });
writeFileSync(
  `${OUT}/rollback.json`,
  JSON.stringify({ binding: before!.bind, sourceCursor: src0!.cursor }, null, 1),
);
console.log("BEFORE bind.fetch_leads:", JSON.stringify(before!.bind.fetch_leads));
console.log("BEFORE source.cursor:", src0!.cursor);

// The feed is newest-first and its cursor walks backwards, so a time window is the
// correct way to ask for "what is new". Dedupe on email absorbs the overlap.
await db.collection("mcp_bindings").updateOne(
  { _id: BINDING },
  {
    $set: {
      "bind.fetch_leads.args": {
        brandId: "fe4479cc-ee44-4f4f-865f-8e4ca211f963",
        sinceHours: 48,
        limit: 25,
      },
    },
  },
);

// The stuck pointer. Nothing reads it now, but leaving it invites the next reader to
// believe the source is mid-sweep.
await db.collection("sources").updateOne({ _id: SOURCE }, { $unset: { cursor: "" } });

const after = await db.collection("mcp_bindings").findOne({ _id: BINDING });
const src1 = await db.collection("sources").findOne({ _id: SOURCE });
console.log("AFTER  bind.fetch_leads:", JSON.stringify(after!.bind.fetch_leads));
console.log("AFTER  source.cursor:", src1!.cursor ?? "(unset)");

await c.close();
