import { NextResponse, type NextRequest } from "next/server";
import { registerClient } from "@/auth/oauth-server.js";

export const dynamic = "force-dynamic";

/**
 * Dynamic client registration. Open by design — a client id alone grants nothing; every
 * token still requires a human to sign in and approve on the consent screen.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { client_name?: string; redirect_uris?: string[] };
    const redirectUris = body.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      return NextResponse.json({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, { status: 400 });
    }
    const client = await registerClient({
      clientName: body.client_name ?? "MCP client",
      redirectUris,
    });
    return NextResponse.json({ ...client, token_endpoint_auth_method: "none" }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: err instanceof Error ? err.message : "bad request" },
      { status: 400 },
    );
  }
}
