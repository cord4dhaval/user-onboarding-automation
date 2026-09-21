/**
 * The picture a message was written around ("picture + short text", 2026-09-21).
 *
 * Stored on the action itself rather than chosen by keywords at send: the text under it
 * says what the numbers in it cost, so it has to be exactly the picture the writer saw.
 * The product keeps its set in `config.email.pictures`; an action copies the one it uses.
 * Only the designed version shows it; the letter and plain text go without.
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
