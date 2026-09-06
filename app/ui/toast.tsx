"use client";

import { type ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";

/**
 * Confirmation that something finished.
 *
 * The bell carries state the engine noticed on its own; a toast carries the result of
 * something the person just did. Without it, an action that changes a number three rows
 * down the page reads as no action at all.
 *
 * Backed by sonner rather than by the hand-rolled stack this replaced. The visible part was
 * the easy part: what was missing was a queue that survives five results landing at once, a
 * hover that stops the timer while you are reading, dismissal by swipe or keyboard, and a
 * live region that announces the message without interrupting whatever else is being read.
 * The API here is unchanged — `useToast()` still returns a function taking title, body and
 * tone — so no call site moves.
 */

type Tone = "good" | "info" | "bad";

interface ToastInput {
  tone: Tone;
  title: string;
  body?: string;
}

/**
 * Kept as a provider even though sonner needs no context, because the layout mounts one and
 * the alternative is every screen remembering to render a `<Toaster />`.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        position="bottom-right"
        // The app's own tokens rather than sonner's palette: a toast that does not match the
        // surface it lands on reads as a browser notification, not as part of the product.
        toastOptions={{ className: "toast", unstyled: false }}
        richColors={false}
        closeButton
        gap={10}
        duration={5000}
      />
    </>
  );
}

const ICON: Record<Tone, ReactNode> = {
  good: <CircleCheck size={16} />,
  info: <Info size={16} />,
  bad: <TriangleAlert size={16} />,
};

export function useToast() {
  return ({ tone, title, body }: ToastInput) => {
    toast[tone === "good" ? "success" : tone === "bad" ? "error" : "message"](title, {
      description: body,
      icon: ICON[tone],
    });
  };
}
