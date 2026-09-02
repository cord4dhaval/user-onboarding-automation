"use client";

/**
 * The editable fields for one block, keyed by type.
 *
 * Kept apart from the drawer so the shape of a block is described in exactly one place —
 * adding a block type means adding a case here and an entry in `blocks.ts`, nothing else.
 */
export default function BlockFields({ block }: { block: Record<string, unknown> }) {
  const type = String(block.type);
  const text = (key: string) => (typeof block[key] === "string" ? (block[key] as string) : "");

  if (type === "subject" || type === "preheader") {
    return (
      <>
        <label>
          Instruction for Claude
          <input name="slot" defaultValue={text("slot")} placeholder="one line, under 55 characters" />
        </label>
        <label>
          Fallback <span className="muted">— used when a touch fires before any session has run</span>
          <input name="fallback" defaultValue={text("fallback")} />
        </label>
      </>
    );
  }

  if (type === "text" || type === "callout") {
    return (
      <label>
        Text <span className="muted">— {"{{first_name}}"} and {"{{company}}"} are filled per person</span>
        <textarea name="fixed" rows={4} defaultValue={text("fixed")} />
      </label>
    );
  }

  if (type === "slot") {
    return (
      <>
        <label>
          Name <span className="muted">— optional; named slots let one template hold several sections</span>
          <input name="name" defaultValue={text("name")} placeholder="opening" />
        </label>
        <label>
          Instruction for Claude
          <textarea name="instruct" rows={3} defaultValue={text("instruct")} />
        </label>
        <label>
          Fallback
          <textarea name="fallback" rows={3} defaultValue={text("fallback")} />
        </label>
      </>
    );
  }

  if (type === "heading") {
    return (
      <>
        <label>
          Level
          <select name="level" defaultValue={String(block.level ?? 1)}>
            <option value="1">1 — display</option>
            <option value="2">2 — section</option>
            <option value="3">3 — small</option>
          </select>
        </label>
        <label>
          Fixed text <span className="muted">— leave empty to have Claude write it</span>
          <input name="fixed" defaultValue={text("fixed")} />
        </label>
        <label>
          Slot name <span className="muted">— when Claude writes it</span>
          <input name="slot" defaultValue={text("slot")} />
        </label>
        <label>
          Fallback
          <input name="fallback" defaultValue={text("fallback")} />
        </label>
      </>
    );
  }

  if (type === "list") {
    const items = Array.isArray(block.items) ? (block.items as string[]) : [];
    return (
      <>
        <label>
          Style
          <select name="style" defaultValue={String(block.style ?? "bullet")}>
            <option value="bullet">Bullets</option>
            <option value="check">Ticks</option>
            <option value="strike">Struck through</option>
          </select>
        </label>
        <label>
          Items <span className="muted">— one per line</span>
          <textarea name="items" rows={5} defaultValue={items.join("\n")} />
        </label>
      </>
    );
  }

  if (type === "card") {
    const rows = Array.isArray(block.rows) ? (block.rows as Array<{ label: string; value: string }>) : [];
    return (
      <>
        <label>
          Title
          <input name="title" defaultValue={text("title")} />
        </label>
        <label>
          Rows <span className="muted">— one per line, as</span> <code>label | value</code>
          <textarea name="rows" rows={5} defaultValue={rows.map((r) => `${r.label} | ${r.value}`).join("\n")} />
        </label>
        <label className="check">
          <input type="checkbox" name="accent" defaultChecked={Boolean(block.accent)} />
          Tint it with the accent colour
        </label>
      </>
    );
  }

  if (type === "image") {
    return (
      <>
        <label>
          Image URL <span className="muted">— must be publicly hosted; clients strip attachments</span>
          <input name="url" defaultValue={text("url")} />
        </label>
        <label>
          Alt text <span className="muted">— what a blocked-image reader sees, so make it the sentence</span>
          <input name="alt" defaultValue={text("alt")} />
        </label>
        <label>
          Width
          <input name="width" type="number" defaultValue={block.width ? String(block.width) : ""} />
        </label>
        <label>
          Link
          <input name="href" defaultValue={text("href")} />
        </label>
      </>
    );
  }

  if (type === "cta") {
    return (
      <>
        <label>
          Label
          <input name="fixed" defaultValue={text("fixed")} />
        </label>
        <label>
          URL <span className="muted">— {"{{trial_link}}"} resolves per person</span>
          <input name="url" defaultValue={text("url")} />
        </label>
      </>
    );
  }

  return <p className="muted">Nothing to configure.</p>;
}
