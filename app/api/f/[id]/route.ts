import { NextResponse, type NextRequest } from "next/server";
import { readAssetFile } from "@/engine/assetFiles.js";

export const dynamic = "force-dynamic";

/**
 * An uploaded asset file, served to whoever asks for it.
 *
 * Unauthenticated, because the reader is an email client fetching an image, and it has no
 * session to offer. A file is only reachable by its id, which is never listed anywhere a
 * stranger can read.
 *
 * Cached as immutable: a replaced file gets a new id rather than new bytes under the old
 * one, so a copy held by a mail proxy can never go stale.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await readAssetFile(id);
  if (!file) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(file.data), {
    status: 200,
    headers: {
      "content-type": file.mime,
      "content-length": String(file.data.byteLength),
      "content-disposition": `inline; filename="${file.name.replace(/[^\w.\- ]/g, "_")}"`,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
