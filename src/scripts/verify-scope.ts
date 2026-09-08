import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { refuseOutOfScope } from "../engine/runlog.js";

/**
 * Who a tool call belongs to, when one connector runs both the routines and the person.
 *
 * The failure this exists for: a scheduled acquire run was open, and every tool call the
 * owner then made from their own Claude session was answered "add_product is not part of
 * the acquire routine" — because runs were keyed on the token, and the scheduled routine
 * and the person hold the same one. Product setup is done by a person talking to Claude,
 * so that is the flow the boundary must never block.
 *
 * Writes only under its own synthetic org, and deletes what it wrote.
 *
 *   npm run verify:scope
 */

const db = await getDb();
const orgId = `verify-scope-${new ObjectId().toString()}`;
const userId = "verify-scope";

let failures = 0;

const openAcquireRun = async (sessionId: string | null) => {
  const now = new Date();
  await db.collection(C.routineRuns).insertOne({
    _id: new ObjectId(),
    orgId,
    productId: "",
    userId,
    sessionId,
    routine: "acquire",
    status: "running",
    startedAt: now,
    lastCallAt: now,
    endedAt: null,
    ms: 0,
    calls: 1,
    errors: 0,
    counters: {},
    firstError: null,
  });
};

const check = async (name: string, sessionId: string | undefined, tool: string, wantRefused: boolean) => {
  const reason = await refuseOutOfScope({ orgId, userId, sessionId }, tool);
  const pass = wantRefused ? reason !== null : reason === null;
  if (!pass) failures++;
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}\n         ${reason ?? "allowed"}`);
};

console.log("\nwith a scheduled acquire run open\n");
await openAcquireRun("session-routine");
await check("acquire keeps its own tools", "session-routine", "classify", false);
await check("acquire cannot create a product", "session-routine", "add_product", true);
await check("acquire cannot do maintain's job", "session-routine", "upsert_template", true);
await check("a person's session can create a product", "session-human", "add_product", false);
await check("a person's session can write its templates", "session-human", "upsert_template", false);
await check("a person's session can draft its campaigns", "session-human", "draft_campaign", false);
await db.collection(C.routineRuns).deleteMany({ orgId });

console.log("\nwith a run written before session ids existed\n");
await openAcquireRun(null);
await check("it cannot capture a session that came after it", "session-human", "add_product", false);
// A client that names no session cannot be told apart from the routine, and refusing on a
// guess would break the setup flow, so nothing is refused. The boundary is best effort.
await check("nor scope a client that names no session", undefined, "add_product", false);
await db.collection(C.routineRuns).deleteMany({ orgId });

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
