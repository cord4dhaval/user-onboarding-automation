"use client";

import { useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import Drawer from "../ui/drawer";
import { Button, SubmitButton } from "../ui/kit";
import CopyButton from "../products/[id]/claude/copy-button";

/**
 * Two ways in, and they are not equals.
 *
 * Claude reads the site and produces the whole first draft — config, segments, voice,
 * brand kit, the template ladder and campaigns. The form below it can only capture six
 * fields, and a founder guessing at their own segments at 9pm guesses badly. So the form
 * is the fallback, and it says so.
 */
export default function AddProduct({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [manual, setManual] = useState(false);

  const prompt = `Set up a new product on the conversion engine from ${url || "<website URL>"}.

Read the site first, then:
1. add_product with the name, slug, one-liner, value props, activation definition,
   voice and the segments you can actually justify from the page. It reads the
   brand off the same site and writes the starter templates for you.
2. get_brand, then upsert_template for the rest of the ladder — activation_nudge,
   value_proof, objection, last_call — plus a segment variant wherever the angle
   genuinely differs. All drafts. Check each with preview_template.
3. draft_campaign four or five times, for campaigns that suit this product.
4. setup_gaps, then tell me what you drafted and what is waiting on me.`;

  return (
    <>
      <Button icon={<Plus />} onClick={() => setOpen(true)}>
        Add product
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add a product"
        description="Claude builds the whole thing from one URL. The form is the fallback."
        width={560}
      >
        <div className="lead-path">
          <div className="lead-icon">
            <Sparkles size={18} />
          </div>
          <div>
            <strong>Let Claude build it</strong>
            <p className="hint">
              It reads the site and writes the config, the segments, the brand kit, a full template ladder and
              four or five draft campaigns. Nothing it creates is active — you approve everything.
            </p>
          </div>
        </div>

        <label>
          Website
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://teamgrid.ai"
          />
          <span className="hint">Paste the prompt below into a Claude session with this engine connected.</span>
        </label>

        <div className="prompt-box">
          <CopyButton text={prompt} />
          <pre>{prompt}</pre>
        </div>

        <details open={manual} onToggle={(event) => setManual((event.target as HTMLDetailsElement).open)}>
          <summary>Or fill it in by hand</summary>
          <form action={action} className="stack manual-form">
            <label>
              Name
              <input name="name" placeholder="TeamGrid" required />
            </label>
            <label>
              Slug
              <input name="slug" placeholder="teamgrid" />
            </label>
            <label>
              Website
              <input name="website" type="url" placeholder="https://teamgrid.ai" defaultValue={url} />
            </label>
            <label>
              One-liner
              <input name="oneLiner" placeholder="Workforce intelligence for teams that bill by the hour" />
            </label>
            <label>
              Main value prop
              <input name="valueProp" placeholder="See where the week actually went, by client" />
            </label>
            <label>
              What counts as activated
              <input name="activation" placeholder="Two teammates tracked and one report opened" />
              <span className="hint">Behaviour, not signup. An inactive trial converts far worse than an active one.</span>
            </label>
            <div className="drawer-foot">
              <SubmitButton icon={<Plus />} pendingLabel="Creating">
                Create product
              </SubmitButton>
              <Button variant="quiet" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </details>
      </Drawer>
    </>
  );
}
