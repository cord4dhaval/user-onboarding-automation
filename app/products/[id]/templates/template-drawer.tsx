"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";

/**
 * Six fields, and four of them have a sane default. The blocks are where a template is
 * actually made, so this asks only what cannot be guessed and then gets out of the way.
 */
export default function TemplateDrawer({
  productId,
  action,
  segmentKeys,
}: {
  productId: string;
  action: (formData: FormData) => void | Promise<void>;
  segmentKeys: string[];
}) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("email");
  const [scope, setScope] = useState("product_default");

  return (
    <>
      <Button icon={<Plus />} onClick={() => setOpen(true)}>
        New template
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="New template"
        description="It opens in the editor as a draft. Drafts are never picked by the cascade."
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />

          <label>
            Name
            <input name="name" placeholder="Day three nudge" required />
          </label>

          <label>
            Channel
            <select name="channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="slack">Slack</option>
            </select>
          </label>

          {channel === "email" && (
            <label>
              Format
              <select name="format" defaultValue="html">
                <option value="html">Designed HTML</option>
                <option value="text">Plain text only</option>
              </select>
              <span className="hint">
                Both are always written; this decides which one the recipient is shown.
              </span>
            </label>
          )}

          <label>
            Stage
            <input name="stage" defaultValue="first_touch" />
            <span className="hint">Where in a sequence this belongs — first_touch, day_three, last_call.</span>
          </label>

          <label>
            Scope
            <select name="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="product_default">Product default</option>
              <option value="segment">One segment</option>
            </select>
            <span className="hint">A segment template overrides the default for people it matches.</span>
          </label>

          {scope === "segment" && (
            <label>
              Segment
              {segmentKeys.length ? (
                <select name="segmentKey" required>
                  {segmentKeys.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              ) : (
                <input name="segmentKey" placeholder="agency_owner" required />
              )}
            </label>
          )}

          <div className="drawer-foot">
            <SubmitButton pendingLabel="Creating">Create and edit</SubmitButton>
            <Button variant="quiet" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Drawer>
    </>
  );
}
