"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../../../ui/kit";

/** A routine prompt is thirty lines long. Nobody should have to select it by hand. */
export default function CopyButton({ text, label = "Copy prompt" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="quiet"
      size="sm"
      icon={copied ? <Check /> : <Copy />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard access can be refused; the prompt is still visible to select by hand.
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
