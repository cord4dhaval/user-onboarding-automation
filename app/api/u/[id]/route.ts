import { NextResponse, type NextRequest } from "next/server";
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
 * them. GET is the link in the message body.
 *
 * GET suppresses immediately rather than showing a confirm button. Mail scanners do
 * prefetch links, so some of these will be machines rather than people — but the cost of
 * that is one lead we stop mailing, and the cost of the other mistake is a person who
 * asked to be left alone and was not. Given the choice, err towards leaving them alone.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await handle(request, ctx, "unsubscribed from a message");
  if (result === "bad") return page("This link is not valid.", "Ask whoever mailed you to remove you by hand.");
  if (result === "missing") return page("We could not find that record.", "You may already have been removed.");
  return page("You have been unsubscribed.", "You will not receive anything further. Nothing else is needed.");
}

/** One-click. The body is ignored by design — the signature is the whole authorisation. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await handle(request, ctx, "one-click unsubscribe");
  if (result === "bad") return new NextResponse("invalid", { status: 404 });
  return new NextResponse("ok", { status: 200, headers: { "content-type": "text/plain" } });
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

/**
 * Plain HTML rather than a React page: this is reached from a mail client, often in a
 * stripped-down webview, and it must render with no styling, no fonts and no scripts.
 */
function page(headline: string, detail: string): NextResponse {
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(headline)}</title></head>
<body style="margin:0;padding:48px 24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101114;background:#fff;">
<div style="max-width:420px;margin:0 auto;">
<h1 style="margin:0 0 8px;font-size:20px;font-weight:600;">${esc(headline)}</h1>
<p style="margin:0;color:#5f5e5a;">${esc(detail)}</p>
</div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
