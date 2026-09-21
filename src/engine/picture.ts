import type { RenderableAsset } from "./compose.js";

/**
 * The picture a message was written around, for template 4 ("picture + short text").
 *
 * Stored on the action itself rather than chosen by keywords at send: the text under it
 * says what the numbers in it cost, so it has to be exactly the picture the writer saw.
 * The product keeps its set in `config.email.pictures`; an action copies the one it uses.
 */
export interface ActionPicture {
  key: string;
  url: string;
  alt: string;
  /** The band colour behind the picture, which is all a reader with images off sees. */
  bg: string;
}

export function pictureOf(action: Record<string, unknown> | null | undefined): ActionPicture | undefined {
  const p = action?.picture as Partial<ActionPicture> | undefined;
  if (!p || typeof p.url !== "string" || !p.url) return undefined;
  return { key: String(p.key ?? ""), url: p.url, alt: String(p.alt ?? ""), bg: typeof p.bg === "string" && p.bg ? p.bg : "#ffffff" };
}

/**
 * What the message carries, with its picture first when it has one.
 *
 * Carried as an image, the picture shows in every format a reviewer can switch to: the
 * picture and designed formats lift it to the top, the letter shows it above the button,
 * and plain text prints its alt text. It is not an asset, so it is never credited or tiered.
 */
export function withPicture(assets: RenderableAsset[], action: Record<string, unknown> | null | undefined): RenderableAsset[] {
  const p = pictureOf(action);
  if (!p) return assets;
  return [{ key: `picture:${p.key}`, tier: "A", kind: "image", oneLine: p.alt, url: p.url }, ...assets];
}
