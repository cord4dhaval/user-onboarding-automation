import { ObjectId } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { bumpPrior, type PriorKey } from "@/engine/outcomes.js";
import { PIXEL, unb64url, verify } from "@/engine/tracking.js";

export const dynamic = "force-dynamic";

/**
 * Where opens and clicks come back.
 *
 * Unauthenticated by necessity — the caller is a mail client, and it has no session. What
 * stands in for auth is the signature: it covers the action and, for a click, the exact
 * destination, so this cannot be turned into an open redirect and a signal cannot be
 * forged for a message that was never sent.
 *
 * A failure here must never cost the reader their click, so anything unexpected still
 * redirects when the destination is intact and only the write failed.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await params;
  const signature = request.nextUrl.searchParams.get("s") ?? "";

  if (!ObjectId.isValid(id)) return new NextResponse(null, { status: 404 });

  if (kind === "o") {
    if (verify("o", id, "", signature)) await record(id, "opened");
    // The pixel is returned either way. A tracking image that 404s shows as a broken
    // placeholder in some clients, which tells the reader they are being counted.
    return pixel();
  }

  if (kind !== "c") return new NextResponse(null, { status: 404 });

  const encoded = request.nextUrl.searchParams.get("u") ?? "";
  let target: string;
  try {
    target = unb64url(encoded);
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (!/^https?:\/\//i.test(target)) return new NextResponse(null, { status: 404 });
  if (!verify("c", id, target, signature)) return new NextResponse(null, { status: 404 });

  await record(id, "clicked");
  return NextResponse.redirect(target, 302);
}

/**
 * One signal per action per kind. A mail client that prefetches images fires the pixel
 * repeatedly, and counting each one would make a single ignored message look like sustained
 * interest — so the first occurrence is what the rollup reads, and later ones are dropped.
 */
async function record(actionId: string, type: "opened" | "clicked"): Promise<void> {
  const field = type === "opened" ? "firstOpenedAt" : "firstClickedAt";
  const now = new Date();
  try {
    const db = await getDb();
    const result = await db.collection(C.actions).findOneAndUpdate(
      { _id: new ObjectId(actionId), [field]: { $exists: false } },
      { $set: { [field]: now }, $push: { signals: { type, at: now } } as never },
      { returnDocument: "after", projection: { orgId: 1, personId: 1, channel: 1, variant: 1 } },
    );
    if (!result) return;

    // The shared prior moves only on a first click. A prefetching client that fires the
    // pixel ten times must not make one ignored message look like ten engaged ones — the
    // filter above already guarantees this runs once.
    if (type === "clicked") await bumpPrior(result as PriorKey, "clicked");
    await db
      .collection(C.people)
      .updateOne(
        { _id: new ObjectId(String(result.personId)), orgId: result.orgId },
        { $set: { lastSignalAt: now } },
      );

    // Sends them to the front of the recompute queue. That queue is ordered oldest-reading
    // first and bounded per tick, so without this the freshest reading in the product —
    // which is what a click produces — would be examined last, and someone who clicked
    // could stay cold for several ticks. Guarded on temp already existing, because a
    // dotted write against an unclassified person would mint a reading with no band.
    if (type === "clicked") {
      await db
        .collection(C.people)
        .updateOne(
          { _id: new ObjectId(String(result.personId)), temp: { $exists: true } },
          { $set: { "temp.computedAt": new Date(0) } },
        );
    }
  } catch {
    // A dropped signal is a lost data point. Failing the request instead would be a lost
    // reader, which is worse.
  }
}

function pixel(): NextResponse {
  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}
