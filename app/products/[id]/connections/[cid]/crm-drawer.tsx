"use client";

import { useState } from "react";
import { Briefcase, Save } from "lucide-react";
import Drawer from "../../../../ui/drawer";
import { Button, SubmitButton } from "../../../../ui/kit";

/**
 * Where a CRM's tenant, projects and map are set.
 *
 * The map is shown whole and editable because it is the generic part: a CRM whose tools
 * are named differently from the draft's guess is corrected here, as data, rather than
 * needing code. Most people only ever touch the first two fields.
 */
export default function CrmDrawer({
  productId,
  connectionId,
  scope,
  projects,
  map,
  action,
  label,
}: {
  productId: string;
  connectionId: string;
  scope: string;
  projects: string;
  map: string;
  action: (formData: FormData) => Promise<void>;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(formData: FormData) {
    setError(null);
    try {
      await action(formData);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" icon={<Briefcase />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="CRM reading"
        description="Which account and projects to read, and how this CRM's tools answer."
        width={640}
      >
        <form action={save} className="stack">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="connectionId" value={connectionId} />
          <label>
            Tenant <span className="muted">(sent with every call, when one login can see several accounts)</span>
            <input name="scope" defaultValue={scope} placeholder='{"orgId": "…"}' />
          </label>
          <label>
            Projects that belong to this product{" "}
            <span className="muted">(ids, comma separated; empty reads every project)</span>
            <input name="projects" defaultValue={projects} placeholder="6a0e…098, 6a0e…09d" />
          </label>
          <p className="sub">
            One CRM often holds several products&apos; deals. A record in a project not listed here is remembered as
            belonging elsewhere and never shown on this product&apos;s leads.
          </p>
          <label>
            Map <span className="muted">(which tool answers what, and where each field sits in its answer)</span>
            <textarea name="map" className="crm-map" defaultValue={map} spellCheck={false} />
          </label>
          {error ? <div className="note warn">{error}</div> : null}
          <SubmitButton icon={<Save />} pendingLabel="Saving…">Save</SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
