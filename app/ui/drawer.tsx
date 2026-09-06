"use client";

import { type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./kit";

/**
 * A side panel for anything that used to be an inline form.
 *
 * Forms rendered under a list push the list off the screen and make a page do two jobs at
 * once. In a drawer the list stays put, and closing returns you exactly where you were.
 *
 * Built on Radix rather than by hand. The hand-written version listened for Escape, hid the
 * body's overflow and focused the first field — which is the visible half of a dialog. The
 * half nobody writes from scratch correctly is the rest: focus is trapped inside while it
 * is open and returned to whatever opened it on close, the page behind is hidden from
 * screen readers, the scrollbar's width is compensated so the page does not jump, and the
 * title and description are announced. Same props as before, so every screen that opens one
 * is untouched.
 */
export default function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  width = 520,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content
          className="drawer"
          style={{ width }}
          // The first field, not the close button: opening a drawer to type and having to
          // tab past a dismiss control is the small tax that makes people avoid drawers.
          onOpenAutoFocus={(event) => {
            const panel = event.currentTarget as HTMLElement;
            const field = panel.querySelector<HTMLElement>("input, select, textarea");
            if (field) {
              event.preventDefault();
              field.focus();
            }
          }}
        >
          <header>
            <div>
              <Dialog.Title asChild>
                <h2>{title}</h2>
              </Dialog.Title>
              {description ? (
                <Dialog.Description asChild>
                  <p className="sub drawer-sub">{description}</p>
                </Dialog.Description>
              ) : (
                // Radix warns when a dialog has no description, and a silent warning in the
                // console is how a real accessibility gap gets normalised.
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="quiet" size="sm" icon={<X />} aria-label="Close" />
            </Dialog.Close>
          </header>
          <div className="drawer-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
