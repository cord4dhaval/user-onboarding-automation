"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import Select from "../../../ui/select";

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
            <Select
              name="channel"
              value={channel}
              onValueChange={setChannel}
              ariaLabel="Channel this template is written for"
              options={[
                { value: "email", label: "Email" },
                { value: "sms", label: "SMS" },
                { value: "whatsapp", label: "WhatsApp" },
                { value: "slack", label: "Slack" },
              ]}
            />
          </label>

          {channel === "email" && (
            <label>
              Format
              <Select
                name="format"
                value="html"
                ariaLabel="Which version the recipient is shown"
                options={[
                  { value: "html", label: "Designed HTML" },
                  { value: "text", label: "Plain text only" },
                ]}
              />
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
            <Select
              name="scope"
              value={scope}
              onValueChange={setScope}
              ariaLabel="Who this template applies to"
              options={[
                { value: "product_default", label: "Product default" },
                { value: "segment", label: "One segment" },
              ]}
            />
            <span className="hint">A segment template overrides the default for people it matches.</span>
          </label>

          {scope === "segment" && (
            <label>
              Segment
              {segmentKeys.length ? (
                <Select
                  name="segmentKey"
                  value={segmentKeys[0] ?? ""}
                  searchable={segmentKeys.length > 8}
                  ariaLabel="Segment this template overrides for"
                  options={segmentKeys.map((key) => ({ value: key, label: key }))}
                />
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
