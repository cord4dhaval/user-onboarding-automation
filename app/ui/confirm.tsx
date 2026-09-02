"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button, SubmitButton } from "./kit";

/**
 * Destructive actions get a modal that names what will be destroyed. A delete button that
 * fires on first click is how people lose work they cannot get back.
 *
 * Wraps a server action: the form posts normally once confirmed, and the confirm button
 * spins until the server comes back rather than sitting there looking unpressed.
 */
export default function ConfirmButton({
  label,
  title,
  body,
  confirmLabel = "Delete",
  action,
  hidden,
  variant = "danger",
  icon = <Trash2 />,
}: {
  label?: string;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /**
   * A server action. Actions bound with their own arguments ignore the FormData they are
   * handed, which is why the parameter is optional here.
   */
  action: (formData: FormData) => void | Promise<void>;
  hidden?: Record<string, string>;
  variant?: "danger" | "quiet";
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        icon={icon}
        onClick={() => setOpen(true)}
        aria-label={label ?? title}
        title={label ?? "Delete"}
      >
        {label}
      </Button>

      {open && (
        <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
            <h2>{title}</h2>
            <div className="sub" style={{ margin: "8px 0 18px" }}>{body}</div>
            <div className="row">
              <form action={action}>
                {Object.entries(hidden ?? {}).map(([k, v]) => (
                  <input key={k} type="hidden" name={k} value={v} />
                ))}
                <SubmitButton className="destructive" pendingLabel="Deleting…">
                  {confirmLabel}
                </SubmitButton>
              </form>
              <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
