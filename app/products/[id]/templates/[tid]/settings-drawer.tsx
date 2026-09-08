"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import Drawer from "../../../../ui/drawer";
import { Button, SubmitButton } from "../../../../ui/kit";
import Select from "../../../../ui/select";

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
              <Select
                name="format"
                value={current.format}
                ariaLabel="Which version the recipient is shown"
                options={[
                  { value: "html", label: "Designed HTML" },
                  { value: "text", label: "Plain text only" },
                ]}
              />
              <span className="hint">
                Both versions are always written. This decides which one the recipient is shown —
                HTML carries the text alongside it, so nobody ever gets an empty message.
              </span>
            </label>
          )}

          <label>
            Status
            <Select
              name="status"
              value={current.status}
              ariaLabel="Template status"
              options={[
                { value: "draft", label: "Draft", hint: "never picked by the cascade" },
                { value: "active", label: "Active" },
                { value: "paused", label: "Paused" },
              ]}
            />
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
