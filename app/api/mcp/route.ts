import { NextResponse, type NextRequest } from "next/server";
import { TOOLS, type ToolCtx } from "@/mcp/server/tools.js";
import { resolveAccessToken } from "@/auth/oauth-server.js";
import { appOrigin } from "@/auth/origin.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Our own MCP server — the surface a Claude routine drives.
 *
 * Every call is resolved to an organisation from the caller's OAuth token, and every tool
 * is scoped to it. A shared static token could not do that: one connector would see every
 * tenant's leads.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

async function unauthorized() {
  const origin = await appOrigin();
  // Tells a compliant client exactly where to go and authorise, rather than just failing.
  return NextResponse.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

async function callerFor(request: NextRequest): Promise<ToolCtx | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : request.nextUrl.searchParams.get("token");
  if (!token) return null;

  const caller = await resolveAccessToken(token);
  if (caller) return { orgId: caller.orgId, userId: caller.userId };

  // Development escape hatch: a single static token, only when one is configured.
  if (process.env.MCP_TOKEN && token === process.env.MCP_TOKEN && process.env.MCP_DEV_ORG_ID) {
    return { orgId: process.env.MCP_DEV_ORG_ID, userId: "dev" };
  }
  return null;
}

export async function POST(request: NextRequest) {
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

  // The handshake and tool listing are open, so a client can discover the server and learn
  // where to authorise. Everything that touches data requires a token.
  if (method === "initialize") {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "conversion-engine", version: "0.1.0" },
    });
  }

  if (method.startsWith("notifications/")) return new NextResponse(null, { status: 202 });

  if (method === "tools/list") {
    return reply({
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === "tools/call") {
    const ctx = await callerFor(request);
    if (!ctx) return unauthorized();

    const name = String(params?.name ?? "");
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return fail(-32601, `unknown tool: ${name}`);

    try {
      const result = await tool.handler((params?.arguments ?? {}) as Record<string, unknown>, ctx);
      return reply({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A tool error rather than a protocol error, so the caller can read it and adapt
      // instead of the session dying.
      return reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
    }
  }

  return fail(-32601, `unknown method: ${method}`);
}

/** Lets a browser or connector confirm the endpoint is alive without speaking JSON-RPC. */
export async function GET(request: NextRequest) {
  const origin = await appOrigin();
  const ctx = await callerFor(request);
  return NextResponse.json({
    name: "conversion-engine",
    protocolVersion: PROTOCOL_VERSION,
    authenticated: Boolean(ctx),
    authorization_server: origin,
    tools: TOOLS.map((t) => t.name),
  });
}
