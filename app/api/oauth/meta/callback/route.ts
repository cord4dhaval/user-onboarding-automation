import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { ObjectId } from "mongodb";
import { verify } from "@/engine/tracking.js";
import { appOrigin } from "@/engine/vars.js";
import { exchangeMetaCode, metaAssetsFor, saveMetaConnection, subscribeMetaApp } from "@/channels/metaConnect.js";

export const dynamic = "force-dynamic";

/** Back to the product's channels, with a word about how it went. */
function back(productId: string, params: Record<string, string>): NextResponse {
  const url = new URL(`${appOrigin()}/products/${productId}/channels`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

/**
 * Where Meta sends someone back after Embedded Signup.
 *
 * Everything the connection needs is worked out here rather than asked for: the code becomes
 * a token, the token says which WhatsApp account was granted, and the account says which
 * number. That replaces the seven-step hand setup — app, system user, asset assignment, a
 * token a second admin has to approve, a subscription nothing tells you is missing, and a
 * phone number id copied off a console page.
 *
 * No session is behind this request; the person arrives from Meta, not from a page of ours.
 * So the product travels in a signed `state` and is checked before anything is written.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state") ?? "";
  const productId = state.split(".")[0] ?? "";
  const signature = state.split(".")[1] ?? "";

  if (!ObjectId.isValid(productId) || !verify("s", productId, "", signature)) {
    return NextResponse.json({ error: "this sign-in link was not issued here" }, { status: 400 });
  }

  // Meta reports a refusal on the redirect rather than by failing it, so a cancelled or
  // blocked sign-in arrives looking like a success with no code.
  const refused = params.get("error_description") ?? params.get("error");
  if (refused) return back(productId, { whatsapp: "refused", why: refused.slice(0, 200) });

  const code = params.get("code") ?? "";
  if (!code) return back(productId, { whatsapp: "refused", why: "Meta sent no code back." });

  const db = await getDb();
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId) });
  if (!product) return NextResponse.json({ error: "unknown product" }, { status: 404 });

  try {
    const token = await exchangeMetaCode(code);
    const { wabaId, phoneNumberId } = await metaAssetsFor(token);
    await subscribeMetaApp(token, wabaId);
    await saveMetaConnection({ orgId: String(product.orgId), productId, token, wabaId, phoneNumberId });
    return back(productId, { whatsapp: "connected" });
  } catch (error) {
    return back(productId, { whatsapp: "failed", why: (error instanceof Error ? error.message : "").slice(0, 200) });
  }
}
