/** Block metadata shared by the editor's list, its drawer and its add menu. */

export interface BlockMeta {
  type: string;
  label: string;
  hint: string;
  /** Blocks with nothing to configure open no drawer. */
  editable: boolean;
}

export const BLOCK_TYPES: BlockMeta[] = [
  { type: "subject", label: "Subject", hint: "The line in the inbox", editable: true },
  { type: "preheader", label: "Preheader", hint: "The grey line beside the subject", editable: true },
  { type: "heading", label: "Heading", hint: "Display type", editable: true },
  { type: "text", label: "Fixed text", hint: "Yours, never rewritten", editable: true },
  { type: "slot", label: "Slot", hint: "Written per person by Claude", editable: true },
  { type: "list", label: "List", hint: "Bullets, ticks or struck through", editable: true },
  { type: "card", label: "Card", hint: "Label and value rows", editable: true },
  { type: "callout", label: "Callout", hint: "One line set apart", editable: true },
  { type: "image", label: "Image", hint: "Publicly hosted URL", editable: true },
  { type: "divider", label: "Divider", hint: "A rule between sections", editable: false },
  { type: "cta", label: "Button", hint: "The one thing to do", editable: true },
  { type: "system", label: "Unsubscribe footer", hint: "Required by law on cold mail", editable: false },
];

export const metaFor = (type: string): BlockMeta =>
  BLOCK_TYPES.find((b) => b.type === type) ?? { type, label: type, hint: "", editable: false };

/** One line describing what a block currently holds, for the collapsed row. */
export function summarise(block: Record<string, unknown>): string {
  const type = String(block.type);
  const text = (key: string) => (typeof block[key] === "string" ? (block[key] as string) : "");

  if (type === "list") {
    const items = Array.isArray(block.items) ? (block.items as string[]) : [];
    return items.length ? `${items.length} item${items.length === 1 ? "" : "s"} — ${items[0]}` : "empty";
  }
  if (type === "card") {
    const rows = Array.isArray(block.rows) ? (block.rows as Array<{ label: string }>) : [];
    return [text("title"), `${rows.length} row${rows.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  }
  if (type === "cta") return `${text("fixed")} → ${text("url")}`;
  if (type === "image") return text("alt") || text("url");
  if (type === "divider") return "—";
  if (type === "system") return "Legal footer and unsubscribe link";

  // Everything else is fixed copy, an instruction, or a fallback — in that order of
  // usefulness, because the fixed text is what actually goes out.
  return text("fixed") || text("fallback") || text("instruct") || text("slot") || "not set";
}
