"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, Link2, Pencil } from "lucide-react";
import Drawer from "../../../../ui/drawer";
import { ActionButton, Button, SubmitButton } from "../../../../ui/kit";

export interface LinkedInView {
  /** Their profile on record, if any. */
  profile: string | null;
  find: {
    status: string;
    url: string | null;
    why: string | null;
    evidence: string | null;
    by: string | null;
    at: string | null;
  } | null;
  /** Where the invite stands, in words: invited, connected, not accepted. */
  state: string | null;
  /** In a campaign where Claude looks for the profile. */
  searched: boolean;
}

const FOUND_BY: Record<string, string> = {
  sure: "Found by Claude: name and company match",
  likely: "Found by Claude: likely match",
  unsure: "Claude found a possible profile and is not sure it is them",
  none: "No LinkedIn profile found",
  confirmed: "Confirmed by a person",
};

/**
 * The lead's LinkedIn profile and how it was found. Where Claude was unsure, a person answers
 * here: use the profile, put in the right one, or say they have none. Nothing is invited
 * until one of those is true.
 */
export default function LinkedInCard({
  view,
  confirm,
  save,
}: {
  view: LinkedInView;
  confirm: (formData: FormData) => void | Promise<void>;
  save: (prev: { error?: string; done?: boolean }, formData: FormData) => Promise<{ error?: string; done?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(save, {});
  useEffect(() => {
    if (state.done) setOpen(false);
  }, [state]);

  const { profile, find } = view;
  const unsure = !profile && find?.status === "unsure";
  const shown = profile ?? find?.url ?? null;
  const label = find?.status ? (FOUND_BY[find.status] ?? null) : null;

  return (
    <div className="card belief">
      <div className="belief-head">
        <strong><Link2 size={13} /> {shown ? <a href={shown} target="_blank" rel="noreferrer">{shown.replace("https://www.", "")}</a> : "No profile yet"}</strong>
        {view.state && <span className="pill">{view.state}</span>}
      </div>
      {label && <p className="muted">{label}{find?.by === "import" ? " (from the 18 September search)" : ""}.</p>}
      {find?.why && <p>{find.why}</p>}
      {find?.evidence && <p className="muted">What matched: {find.evidence}</p>}
      {!shown && !find && view.searched && <p className="muted">Claude looks for their profile on its next LinkedIn run.</p>}
      <div className="row">
        {unsure && (
          <ActionButton action={confirm} size="sm" icon={<Check />} pendingLabel="Saving…">
            Use this profile
          </ActionButton>
        )}
        <Button variant="quiet" size="sm" icon={<Pencil />} onClick={() => setOpen(true)}>
          {shown ? "Change" : "Add profile"}
        </Button>
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="LinkedIn profile"
        description="The profile their invite and messages go to. It replaces any profile found before."
      >
        <form action={action} className="stack">
          <label>
            Profile URL
            <input name="url" type="url" defaultValue={shown ?? ""} placeholder="https://www.linkedin.com/in/…" />
            <span className="hint">Open it first and check the name, company and photo.</span>
          </label>
          {state.error && <p className="form-error">{state.error}</p>}
          <div className="row">
            <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
            <SubmitButton variant="quiet" name="none" value="1" pendingLabel="Saving…">They have no LinkedIn</SubmitButton>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
