"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import Drawer from "../../../../ui/drawer";
import { ActionButton, Button, SubmitButton } from "../../../../ui/kit";
import BlockFields from "./block-fields";
import { BLOCK_TYPES, metaFor, summarise } from "./blocks";

/**
 * The block stack.
 *
 * Every block collapsed to one readable row, with editing in a drawer. Seven blocks
 * expanded into seven open forms is a page you have to scroll past to see the message you
 * are editing — the preview beside it is the point, and it has to stay in view.
 */
export default function BlockList({
  productId,
  templateId,
  blocks,
  onUpdate,
  onAdd,
  onRemove,
  onMove,
}: {
  productId: string;
  templateId: string;
  blocks: Record<string, unknown>[];
  onUpdate: (formData: FormData) => void | Promise<void>;
  onAdd: (formData: FormData) => void | Promise<void>;
  onRemove: (index: number, formData: FormData) => void | Promise<void>;
  onMove: (index: number, direction: -1 | 1, formData: FormData) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const open = editing !== null ? blocks[editing] : undefined;
  const openMeta = open ? metaFor(String(open.type)) : undefined;

  return (
    <>
      <ol className="blocks">
        {blocks.map((block, index) => {
          const meta = metaFor(String(block.type));
          return (
            <li key={`${meta.type}-${index}`} className="block-row">
              <span className="block-kind">{meta.label}</span>
              <span className="block-summary" title={summarise(block)}>
                {summarise(block)}
              </span>
              <span className="block-actions">
                <ActionButton
                  variant="quiet"
                  size="sm"
                  icon={<ArrowUp />}
                  aria-label="Move up"
                  disabled={index === 0}
                  action={onMove.bind(null, index, -1)}
                />
                <ActionButton
                  variant="quiet"
                  size="sm"
                  icon={<ArrowDown />}
                  aria-label="Move down"
                  disabled={index === blocks.length - 1}
                  action={onMove.bind(null, index, 1)}
                />
                {meta.editable && (
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<Pencil />}
                    aria-label={`Edit ${meta.label}`}
                    onClick={() => setEditing(index)}
                  />
                )}
                <ActionButton
                  variant="danger"
                  size="sm"
                  icon={<Trash2 />}
                  aria-label={`Remove ${meta.label}`}
                  disabled={blocks.length === 1}
                  action={onRemove.bind(null, index)}
                />
              </span>
            </li>
          );
        })}
      </ol>

      <Button variant="quiet" icon={<Plus />} onClick={() => setAdding(true)}>
        Add block
      </Button>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={openMeta ? `Edit ${openMeta.label.toLowerCase()}` : "Edit block"}
        description={openMeta?.hint}
      >
        {open && (
          <form action={onUpdate} className="stack" onSubmit={() => setEditing(null)}>
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="templateId" value={templateId} />
            <input type="hidden" name="index" value={editing ?? 0} />
            <BlockFields block={open} />
            <div className="drawer-foot">
              <SubmitButton pendingLabel="Saving">Save block</SubmitButton>
              <Button variant="quiet" type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Drawer>

      <Drawer
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a block"
        description="It lands at the end of the stack; move it from there."
        width={460}
      >
        <div className="pick">
          {BLOCK_TYPES.map((meta) => (
            <form key={meta.type} action={onAdd} onSubmit={() => setAdding(false)}>
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="templateId" value={templateId} />
              <input type="hidden" name="type" value={meta.type} />
              <SubmitButton variant="quiet" className="pick-item" pendingLabel="Adding">
                <span className="pick-label">{meta.label}</span>
                <span className="pick-hint">{meta.hint}</span>
              </SubmitButton>
            </form>
          ))}
        </div>
      </Drawer>
    </>
  );
}
