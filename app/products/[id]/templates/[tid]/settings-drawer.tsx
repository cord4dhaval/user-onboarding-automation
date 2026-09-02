"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import Drawer from "../../../../ui/drawer";
import { Button, SubmitButton } from "../../../../ui/kit";

export default function SettingsDrawer({
  productId,
  templateId,
  action,
  isEmail,
  current,
}: {
  productId: string;
  templateId: string;
  action: (formData: FormData) => void | Promise<void>;
  isEmail: boolean;
  current: {
    name: string;
    stage: string;
    status: string;
    format: string;
    maxWords?: number;
    noClaims: string[];
  };
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="quiet" size="sm" icon={<Settings />} onClick={() => setOpen(true)}>
        Settings
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Template settings"
        description="What this template is called, when it sends, and what it may never claim."
      >
        <form action={action} className="stack" onSubmit={() => setOpen(false)}>
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="templateId" value={templateId} />

          <label>
            Name
            <input name="name" defaultValue={current.name} required />
          </label>

          <label>
            Stage
            <input name="stage" defaultValue={current.stage} />
          </label>

          {isEmail && (
            <label>
              Format
              <select name="format" defaultValue={current.format}>
                <option value="html">Designed HTML</option>
                <option value="text">Plain text only</option>
              </select>
              <span className="hint">
                Both versions are always written. This decides which one the recipient is shown —
                HTML carries the text alongside it, so nobody ever gets an empty message.
              </span>
            </label>
          )}

          <label>
            Status
            <select name="status" defaultValue={current.status}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
            <span className="hint">A draft is never picked by the cascade.</span>
          </label>

          <label>
            Word ceiling
            <input name="maxWords" type="number" min={10} defaultValue={current.maxWords ?? ""} />
          </label>

          <label>
            Claims that must never appear <span className="muted">— one per line</span>
            <textarea name="noClaims" rows={4} defaultValue={current.noClaims.join("\n")} />
          </label>

          <div className="drawer-foot">
            <SubmitButton pendingLabel="Saving">Save settings</SubmitButton>
            <Button variant="quiet" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
