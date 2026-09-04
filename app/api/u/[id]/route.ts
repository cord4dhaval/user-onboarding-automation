import { NextResponse, type NextRequest } from "next/server";
import { markScannerPass } from "@/engine/engagement.js";
import { unsubscribePerson } from "@/engine/unsubscribe.js";
import { verify } from "@/engine/tracking.js";

export const dynamic = "force-dynamic";

/**
 * Where someone leaves.
 *
 * Unauthenticated, because the person has no account here. The signature stands in for
 * auth: it covers the person id, so this cannot be used to unsubscribe anyone whose link
 * you were not sent.
 *
 * POST is the RFC 8058 one-click form — Gmail and Yahoo call it directly from their own
 * unsubscribe button, and offering it is what keeps a bulk sender in good standing with
 * them. It suppresses without asking, because the reader already pressed a button to get
 * there. GET is the link in the message body, and it only asks.
 *
 * GET used to suppress on sight, reasoning that a scanner prefetching the link costs one
 * lead while ignoring a real request costs a person who asked to be left alone. That trade
 * was never necessary. Mail security gateways fetch every link in a message within seconds
 * of delivery, and five of one product's leads were suppressed exactly that way — each
 * unsubscribed within two seconds of the same gateway "clicking" the call to action, six
 * to sixty seconds after the message was sent. A confirm button ends it, because no
 * scanner submits a form, and the path that must not ask is POST and still does not.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const signature = request.nextUrl.searchParams.get("s") ?? "";

  // Checked even though nothing is written here, so a broken link says so plainly rather
  // than offering a button that fails after it is pressed.
  if (!verify("u", id, "", signature)) {
    return page("This link is not valid.", "Ask whoever mailed you to remove you by hand.");
  }

  // A gateway that fetches this link has just identified itself, and it fetched the call to
  // action seconds earlier in the same pass. That click is retracted here rather than left
  // standing as interest — this route is the only place with proof of what it was.
  await markScannerPass(id, new Date());

  // A query-only action resolves against this URL, so the signature rides along without
  // the page having to know its own path.
  return page(
    "Unsubscribe?",
    "Press the button and you will not receive anything further from us.",
    `<form method="post" action="?s=${esc(signature)}" style="margin:24px 0 0;">
<button type="submit" name="confirm" value="1" style="appearance:none;border:0;border-radius:6px;background:#101114;color:#fff;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px 20px;cursor:pointer;">Unsubscribe</button>
</form>`,
  );
}

/**
 * One-click, and the confirm button from the page above.
 *
 * RFC 8058 sends `List-Unsubscribe=One-Click` and wants a machine-readable reply; the
 * button sends `confirm=1` and wants a page a person can read. The signature is the whole
 * authorisation either way — the body only decides what comes back.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const byHand = await pressedConfirm(request);
  const result = await handle(request, ctx, byHand ? "unsubscribed from a message" : "one-click unsubscribe");

  if (!byHand) {
    if (result === "bad") return new NextResponse("invalid", { status: 404 });
    return new NextResponse("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }

  if (result === "bad") return page("This link is not valid.", "Ask whoever mailed you to remove you by hand.");
  if (result === "missing") return page("We could not find that record.", "You may already have been removed.");
  return page("You have been unsubscribed.", "You will not receive anything further. Nothing else is needed.");
}

/**
 * Whether this came from the confirm button rather than a mail provider.
 *
 * Tolerates an empty or non-form body: a provider is free to send either, and neither is a
 * reason to refuse an unsubscribe.
 */
async function pressedConfirm(request: NextRequest): Promise<boolean> {
  try {
    return new URLSearchParams(await request.text()).get("confirm") === "1";
  } catch {
    return false;
  }
}

async function handle(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  reason: string,
): Promise<"ok" | "bad" | "missing"> {
  const { id } = await params;
  const signature = request.nextUrl.searchParams.get("s") ?? "";
  if (!verify("u", id, "", signature)) return "bad";

  const result = await unsubscribePerson(id, reason);
  return result.found ? "ok" : "missing";
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);

/**
 * Plain HTML rather than a React page: this is reached from a mail client, often in a
 * stripped-down webview, and it must render with no styling, no fonts and no scripts.
 *
 * `extra` is markup this file builds itself and is emitted unescaped. Nothing from the
 * request reaches it except through `esc`.
 */
function page(headline: string, detail: string, extra = ""): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(headline)}</title></head>
<body style="margin:0;padding:48px 24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101114;background:#fff;">
<div style="max-width:420px;margin:0 auto;">
<h1 style="margin:0 0 8px;font-size:20px;font-weight:600;">${esc(headline)}</h1>
<p style="margin:0;color:#5f5e5a;">${esc(detail)}</p>
${extra}
</div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
