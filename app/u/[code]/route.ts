import { NextResponse, type NextRequest } from "next/server";
import { expandShortUnsubscribe } from "@/engine/unsubscribe.js";

export const dynamic = "force-dynamic";

/**
 * The short unsubscribe link printed in plain-text mail.
 *
 * It only redirects to the full signed link, so the confirm page, the one-click POST and the
 * scanner handling all live in one route. A code we did not issue gets a plain not-found:
 * there is nothing to confirm and nobody to name.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const target = expandShortUnsubscribe(code);
  if (!target) {
    return new NextResponse("This link is not valid. Reply to the email and ask to be removed.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.redirect(new URL(target, request.url), 302);
}
