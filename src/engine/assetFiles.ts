import { GridFSBucket, ObjectId } from "mongodb";
import { getDb } from "../db/client.js";

/**
 * Files people upload for an asset, kept in the database rather than on a disk.
 *
 * The console runs on serverless functions with no disk that outlives a request, and the
 * alternative was pasting a URL to a file hosted somewhere else — which is how an asset
 * came to point at a link nobody could see from the form. GridFS splits a file into
 * chunks under Mongo's document limit, so an image or a PDF sits beside the asset that
 * names it and is served back from one route of our own.
 *
 * The route is public because an email client fetching an image cannot sign in. The id is
 * an ObjectId nobody can list, which is the same protection a hosted file link has.
 */

export const ASSET_FILE_BUCKET = "asset_files";

/**
 * The ceiling on one upload. A server action's body is capped by the platform at about four
 * and a half megabytes, and an email carrying more than a few megabytes of picture is a
 * message that clips in Gmail and loads slowly everywhere else.
 */
export const MAX_ASSET_FILE_BYTES = 4 * 1024 * 1024;

/** What may be uploaded, and the asset kind each type becomes. */
const KIND_BY_MIME: Record<string, "image" | "video" | "document"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "document",
  "video/mp4": "video",
};

export const ACCEPTED_ASSET_TYPES = Object.keys(KIND_BY_MIME).join(",");

export function kindForMime(mime: string): "image" | "video" | "document" | null {
  return KIND_BY_MIME[mime.toLowerCase()] ?? null;
}

export interface StoredAssetFile {
  fileId: string;
  mime: string;
  bytes: number;
}

async function bucket(): Promise<GridFSBucket> {
  return new GridFSBucket(await getDb(), { bucketName: ASSET_FILE_BUCKET });
}

/** Refuses what cannot be served back into an email, with a reason a person can act on. */
export async function storeAssetFile(input: {
  orgId: string;
  productId: string;
  name: string;
  mime: string;
  data: Buffer;
}): Promise<StoredAssetFile> {
  const mime = input.mime.toLowerCase();
  if (!kindForMime(mime)) {
    throw new Error(`${input.name} is a ${mime || "file of unknown type"}. Upload a PNG, JPEG, WebP, GIF, PDF or MP4.`);
  }
  if (input.data.byteLength > MAX_ASSET_FILE_BYTES) {
    const mb = (input.data.byteLength / 1024 / 1024).toFixed(1);
    throw new Error(`${input.name} is ${mb} MB. The limit is 4 MB; paste a link for anything larger.`);
  }

  const stream = (await bucket()).openUploadStream(input.name, {
    metadata: { orgId: input.orgId, productId: input.productId, mime },
  });
  await new Promise<void>((resolve, reject) => {
    stream.once("finish", () => resolve());
    stream.once("error", reject);
    stream.end(input.data);
  });

  return { fileId: String(stream.id), mime, bytes: input.data.byteLength };
}

/** The file's bytes and type, or null when the id names nothing. */
export async function readAssetFile(id: string): Promise<{ data: Buffer; mime: string; name: string } | null> {
  if (!ObjectId.isValid(id)) return null;
  const files = await bucket();
  const _id = new ObjectId(id);
  const info = await files.find({ _id }).next();
  if (!info) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of files.openDownloadStream(_id)) chunks.push(chunk as Buffer);
  const mime = String((info.metadata as { mime?: string } | undefined)?.mime ?? "application/octet-stream");
  return { data: Buffer.concat(chunks), mime, name: info.filename };
}

/** Never fatal: a file left behind costs storage, a failed save costs the person's edit. */
export async function deleteAssetFile(id: string | undefined): Promise<void> {
  if (!id || !ObjectId.isValid(id)) return;
  try {
    await (await bucket()).delete(new ObjectId(id));
  } catch {
    // Already gone, or never finished uploading. Either way there is nothing to remove.
  }
}

/** Where the file is served from. An absolute URL, because an email has no base to resolve against. */
export function assetFileUrl(origin: string, fileId: string): string {
  return `${origin.replace(/\/$/, "")}/api/f/${fileId}`;
}
