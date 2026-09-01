import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";

/**
 * The tool schemas kept from the last discovery of a connection, so a client can check a
 * call before making it without paying for a tools/list round trip on every send.
 */
export async function schemasFor(connectionId: string): Promise<Record<string, unknown>> {
  const db = await getDb();
  const binding = await db.collection(C.mcpBindings).findOne({ connectionId });
  const tools = (binding?.discoveredTools ?? []) as Array<{ name?: string; inputSchema?: unknown }>;
  const map: Record<string, unknown> = {};
  for (const tool of tools) {
    if (tool?.name && tool.inputSchema) map[tool.name] = tool.inputSchema;
  }
  return map;
}
