import { ObjectId, type Document } from "mongodb";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { bumpPrior, type PriorKey } from "@/engine/outcomes.js";
import { notify } from "@/engine/notify.js";
import { PIXEL, looksAutomated, signalField, unb64url, verify } from "@/engine/tracking.js";

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

  const agent = request.headers.get("user-agent");

  if (kind === "o") {
    if (verify("o", id, "", signature)) await record(id, "opened", agent);
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

  await record(id, "clicked", agent, target);
  return NextResponse.redirect(target, 302);
}

/**
 * One signal per action per kind, per kind of visitor.
 *
 * Two things are deduped here, for different reasons. A mail client that prefetches images
 * fires the pixel repeatedly, and counting each one would make a single ignored message
 * look like sustained interest. And a security gateway walks every link seconds after
 * delivery, which is not interest at all — it is the message being scanned.
 *
 * So machine and human are recorded in separate fields rather than the machine simply
 * winning by arriving first. That ordering mattered: the gateway always gets there before
 * the reader, and a single first-wins field meant the scanner's fetch permanently masked
 * the click a person made forty minutes later. Everything that counts clicks reads the
 * human field, and the machine field exists so the console can say how many were filtered
 * rather than quietly dropping them.
 */
async function record(
  actionId: string,
  type: "opened" | "clicked",
  agent?: string | null,
  url?: string,
): Promise<void> {
  const now = new Date();
  try {
    const db = await getDb();
    // Read first, because which field this belongs in depends on when the message was sent.
    const action = await db
      .collection(C.actions)
      .findOne({ _id: new ObjectId(actionId) }, { projection: { sentAt: 1 } });
    if (!action) return;

    const machine = looksAutomated({ sentAt: action.sentAt as Date | undefined, at: now, userAgent: agent });
    const field = signalField(type, machine);

    const result = await db.collection(C.actions).findOneAndUpdate(
      { _id: new ObjectId(actionId), [field]: { $exists: false } },
      // The destination is kept on the signal, not only the fact of a click. "Clicked" is
      // one answer; "clicked the pricing link" is the one a person acts on.
      {
        $set: { [field]: now },
        $push: { signals: { type, at: now, ...(url ? { url } : {}), ...(machine ? { bot: true } : {}) } } as never,
      },
      {
        returnDocument: "after",
        projection: { orgId: 1, productId: 1, personId: 1, channel: 1, variant: 1, "content.subject": 1 },
      },
    );
    if (!result) return;

    // Nothing downstream hears about a scanner. It must not move a prior, warm a lead, or
    // put a notification in front of a person — each of those would be acting on a machine
    // reading its own mail.
    //
    // A message that was never sent is treated the same way. Its links can still be reached
    // — from a preview, or a test — and that is worth recording as the oddity it is, but
    // nobody clicked anything we sent them, so it must not warm a lead or claim one did.
    if (machine || !action.sentAt) return;

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

    await announce(result as Document, type, url);
  } catch {
    // A dropped signal is a lost data point. Failing the request instead would be a lost
    // reader, which is worse.
  }
}

/**
 * Tells the owner, in the bell, that somebody responded.
 *
 * This is the whole point of tracking and it was going nowhere: a campaign could collect
 * nine clicks and the console would report the same silence as one that collected none.
 *
 * A click is severity "action" because it asks for a decision — this is the moment to
 * reach out, and it goes stale within the day. An open is only "good": mail clients
 * prefetch images, so it is worth knowing and not worth acting on, and the copy says so
 * rather than letting a reader mistake a proxy for a person.
 *
 * Deduped per person per kind, so somebody working through five links is one row that
 * counts to five rather than five rows burying everything else in the panel.
 */
async function announce(action: Document, type: "opened" | "clicked", url?: string): Promise<void> {
  const productId = action.productId ? String(action.productId) : "";
  if (!productId) return;

  const db = await getDb();
  const person = await db
    .collection(C.people)
    .findOne(
      { _id: new ObjectId(String(action.personId)) },
      { projection: { name: 1, primaryEmail: 1 } },
    );
  const who = String(person?.name ?? person?.primaryEmail ?? "Someone");
  const subject = (action.content as { subject?: string } | undefined)?.subject;

  await notify({
    orgId: String(action.orgId),
    productId,
    severity: type === "clicked" ? "action" : "good",
    dedupeKey: `engagement:${type}:${String(action.personId)}`,
    title: type === "clicked" ? `${who} clicked a link` : `${who} opened your email`,
    body:
      type === "clicked"
        ? [subject ? `"${subject}"` : null, url ? host(url) : null, "Warm right now — reply while it is."]
            .filter(Boolean)
            .join(" · ")
        : [subject ? `"${subject}"` : null, "Opens are unreliable: some clients load images on their own."]
            .filter(Boolean)
            .join(" · "),
    href: `/products/${productId}/library/${String(action.personId)}`,
  });
}

/** The destination as a person would name it, not as a query string. */
function host(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
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
