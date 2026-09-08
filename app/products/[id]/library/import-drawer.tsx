"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import Select from "../../../ui/select";

export default function ImportDrawer({
  productId,
  action,
}: {
  productId: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"paste" | "file">("paste");

  return (
    <>
      <Button icon={<UserPlus />} onClick={() => setOpen(true)}>Add people</Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add people to the library"
        description="No campaign needed. They sit here until you build an audience from them."
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />

          <label>
            How
            <Select
              value={mode}
              onValueChange={(next) => setMode(next as "paste" | "file")}
              ariaLabel="How to add these people"
              options={[
                { value: "paste", label: "Paste addresses", hint: "one per line" },
                { value: "file", label: "Upload a spreadsheet", hint: "xlsx or csv" },
              ]}
            />
          </label>

          {mode === "paste" ? (
            <label>
              One per line
              <textarea
                name="pasted"
                placeholder={"rahul@brightpixel.in\nPriya Nair <priya@cloudnine.dev>"}
                style={{ minHeight: 160 }}
              />
            </label>
          ) : (
            <label>
              File <span className="muted">(.xlsx or .csv — columns read from the header row)</span>
              <input name="file" type="file" accept=".xlsx,.xls,.csv" />
            </label>
          )}

          <p className="sub" style={{ margin: 0 }}>
            Anyone already here gains an arrival rather than a duplicate record. Anyone who has said no is
            skipped and stays that way.
          </p>

          <SubmitButton pendingLabel="Adding…">Add to library</SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
