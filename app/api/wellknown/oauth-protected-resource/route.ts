import { NextResponse } from "next/server";
import { appOrigin } from "@/auth/origin.js";

export const dynamic = "force-dynamic";

/** Points a client from the MCP endpoint to the authorization server that guards it. */
export async function GET() {
  const origin = await appOrigin();
  return NextResponse.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["engine.read", "engine.write"],
    bearer_methods_supported: ["header"],
  });
}
