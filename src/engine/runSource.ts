import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { ingest, type IngestSummary } from "./ingest.js";
import { RowsAdapter } from "../adapters/source/rows.js";
import { McpSourceAdapter } from "../adapters/source/mcp.js";
import { HttpSourceAdapter } from "../adapters/source/http.js";
import { McpClient } from "../mcp/client.js";
import { resolveSecret } from "../crypto/broker.js";
import type { RawRecord, SourceAdapter } from "../adapters/source/types.js";
import type { Binding } from "../mcp/binding.js";

/**
 * One entry point for all three doors: a webhook push, a cron poll, and the MCP tool the
 * Claude routine calls. Same code, so behaviour cannot drift between them.
 */
export async function runSource(sourceId: string, pushedRows?: RawRecord[]): Promise<IngestSummary> {
  const db = await getDb();
  const source = await db.collection(C.sources).findOne({ _id: new ObjectId(sourceId) });
  if (!source) throw new Error(`source ${sourceId} not found`);

  const adapter = pushedRows
    ? new RowsAdapter(pushedRows)
    : await buildAdapter(source);

  const summary = await ingest(source as never, adapter);

  // Cursor advances only now, after every record has been committed. Advancing it before
  // ingest would silently lose the batch on any mid-run failure.
  const interval = source.effectiveIntervalSec ?? source.desiredIntervalSec ?? 600;
  await db.collection(C.sources).updateOne(
    { _id: source._id },
    {
      $set: {
        lastRunAt: new Date(),
        nextFetchAt: new Date(Date.now() + interval * 1000),
        health: { status: summary.errors.length ? "degraded" : "healthy" },
      },
    },
  );

  return summary;
}

async function buildAdapter(source: Record<string, unknown>): Promise<SourceAdapter> {
  const db = await getDb();

  if (source.kind === "api_pull") {
    const connection = await db
      .collection(C.connections)
      .findOne({ _id: new ObjectId(String(source.connectionId)) });
    if (!connection?.endpointUrl) throw new Error("API source has no endpoint URL");
    const token = await resolveSecret(String(source.orgId), String(source.connectionId), "runSource");
    return new HttpSourceAdapter(
      String(connection.endpointUrl),
      token,
      source.cursorParam ? String(source.cursorParam) : undefined,
    );
  }

  if (source.kind !== "mcp_source" && source.kind !== "crm_sync") {
    throw new Error(`source kind "${String(source.kind)}" needs pushed rows, not a fetch`);
  }

  const binding = await db
    .collection(C.mcpBindings)
    .findOne({ orgId: source.orgId, connectionId: source.connectionId });
  if (!binding) throw new Error("no MCP binding for this source's connection");

  const connection = await db
    .collection(C.connections)
    .findOne({ _id: new ObjectId(String(source.connectionId)) });
  if (!connection?.serverUrl) throw new Error("connection has no server URL");

  const token = await resolveSecret(String(source.orgId), String(source.connectionId), "runSource");
  const client = new McpClient(String(connection.serverUrl), token);
  return new McpSourceAdapter(client, binding.bind as Binding);
}

/** Every source whose interval has elapsed. Drives the cron and the routine alike. */
export async function dueSources(orgId: string, at = new Date()): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .collection(C.sources)
    .find({
      orgId,
      enabled: true,
      kind: { $in: ["mcp_source", "api_pull", "crm_sync"] },
      $or: [{ nextFetchAt: { $lte: at } }, { nextFetchAt: { $exists: false } }],
    })
    .project({ _id: 1 })
    .toArray();
  return rows.map((r) => String(r._id));
}
