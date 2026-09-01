import { NextResponse } from "next/server";
import { appOrigin } from "@/auth/origin.js";

export const dynamic = "force-dynamic";

/** Metadata a client reads before starting the flow. PKCE is the only method offered. */
export async function GET() {
  const origin = await appOrigin();
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["engine.read", "engine.write"],
  });
}
