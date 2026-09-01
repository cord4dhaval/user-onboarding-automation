import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, refresh } from "@/auth/oauth-server.js";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const grantType = String(form.get("grant_type") ?? "");
  const clientId = String(form.get("client_id") ?? "");

  try {
    if (grantType === "authorization_code") {
      const tokens = await exchangeCode({
        code: String(form.get("code") ?? ""),
        clientId,
        redirectUri: String(form.get("redirect_uri") ?? ""),
        codeVerifier: String(form.get("code_verifier") ?? ""),
      });
      return NextResponse.json(tokens);
    }

    if (grantType === "refresh_token") {
      const tokens = await refresh({ refreshToken: String(form.get("refresh_token") ?? ""), clientId });
      return NextResponse.json(tokens);
    }

    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  } catch (err) {
    // Deliberately terse: a detailed reason would help someone probe for valid codes.
    const code = err instanceof Error ? err.message : "invalid_grant";
    return NextResponse.json({ error: code === "invalid_grant" ? "invalid_grant" : "invalid_request" }, { status: 400 });
  }
}
