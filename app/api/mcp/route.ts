import { NextResponse, type NextRequest } from "next/server";
import { TOOLS } from "@/mcp/server/tools.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Our own MCP server — the surface a Claude routine drives.
 *
 * Responses are plain JSON rather than server-sent events: every tool here returns a
 * single result, so a stream would add framing for nothing.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.MCP_TOKEN;
  if (!expected) return true; // Local development with no token configured.
  const header = request.headers.get("authorization");
  if (header === `Bearer ${expected}`) return true;
  // A connector that cannot set headers can pass the token in the query string instead.
  return request.nextUrl.searchParams.get("token") === expected;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
  }

  const { id, method, params } = body;
  const reply = (result: unknown) => NextResponse.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "conversion-engine", version: "0.1.0" },
    });
  }

  // Notifications carry no id and expect no body.
  if (method.startsWith("notifications/")) return new NextResponse(null, { status: 202 });

  if (method === "tools/list") {
    return reply({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return fail(-32601, `unknown tool: ${name}`);

    try {
      const result = await tool.handler((params?.arguments ?? {}) as Record<string, unknown>);
      return reply({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Reported as a tool error rather than a protocol error, so the caller can read it
      // and decide what to do instead of the session dying.
      return reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
    }
  }

  return fail(-32601, `unknown method: ${method}`);
}

/** Lets a browser or a connector check the endpoint is alive without speaking JSON-RPC. */
export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    name: "conversion-engine",
    protocolVersion: PROTOCOL_VERSION,
    tools: TOOLS.map((t) => t.name),
  });
}
