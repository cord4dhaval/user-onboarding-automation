import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";
import { McpClient, hashTools, type McpTool } from "./client.js";
import { inferCapabilities } from "./discover.js";

export interface ReverifyResult {
  status: "healthy" | "verifying" | "degraded";
  tools: McpTool[];
  /** Verbs whose bound tool no longer exists for the credential now in use. */
  missing: string[];
  error?: string;
}

/**
 * Lists the server's tools with whatever credential the connection currently holds, and
 * records what that credential can actually reach.
 *
 * This runs after a re-authorisation as well as after a plain discovery, because the two
 * are the same question: the bindings were saved against one account's tool list, and a
 * different account may not be able to see every tool in it. Answering that here means a
 * narrowed account shows up on the connection immediately, rather than as a send that
 * fails hours later in the provider's own words.
 */
export async function reverifyConnection(orgId: string, connectionId: string): Promise<ReverifyResult> {
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId), orgId });
  if (!connection?.serverUrl) throw new Error("connection not found");

  let tools: McpTool[];
  try {
    const token = await resolveSecret(orgId, connectionId, "ui.discover");
    tools = await new McpClient(String(connection.serverUrl), token).listTools();
  } catch (err) {
    // A server that speaks a dialect we cannot read, or a credential that was just
    // narrowed, is a normal thing to have to diagnose — surface it on the connection
    // rather than throwing a crash page.
    const error = err instanceof Error ? err.message : String(err);
    await db
      .collection(C.connections)
      .updateOne({ _id: new ObjectId(connectionId) }, { $set: { status: "degraded", lastError: error } });
    return { status: "degraded", tools: [], missing: [], error };
  }

  const binding = await db.collection(C.mcpBindings).findOne({ orgId, connectionId });
  const bind = (binding?.bind ?? {}) as Record<string, { tool?: string }>;
  const names = new Set(tools.map((t) => t.name));
  const missing = Object.entries(bind)
    .filter(([, spec]) => spec?.tool && !names.has(spec.tool))
    .map(([verb]) => verb);

  await db.collection(C.mcpBindings).updateOne(
    { orgId, connectionId },
    {
      $set: {
        orgId,
        connectionId,
        discoveredTools: tools,
        capabilities: inferCapabilities(tools),
        toolsHash: hashTools(tools),
        discoveredAt: new Date(),
      },
      $setOnInsert: { bind: {} },
    },
    { upsert: true },
  );

  // Bound and reachable is healthy; bound but unreachable is degraded and says which verb;
  // nothing bound yet is still only verifying.
  const error = missing.length
    ? `This account cannot see ${missing
        .map((verb) => `${bind[verb]?.tool} (${verb})`)
        .join(", ")}. Re-bind ${missing.length === 1 ? "that action" : "those actions"} or reconnect as an account that can.`
    : undefined;
  const status: ReverifyResult["status"] = missing.length
    ? "degraded"
    : Object.keys(bind).length
      ? "healthy"
      : "verifying";

  await db.collection(C.connections).updateOne(
    { _id: new ObjectId(connectionId) },
    error
      ? { $set: { status, lastError: error, lastVerifiedAt: new Date() } }
      : { $set: { status, lastVerifiedAt: new Date() }, $unset: { lastError: "" } },
  );

  return { status, tools, missing, error };
}
