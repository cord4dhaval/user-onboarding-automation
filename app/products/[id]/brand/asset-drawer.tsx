"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import Select, { MultiSelect } from "../../../ui/select";

export interface AssetDraft {
  id: string;
  key: string;
  name: string;
  kind: string;
  tier: string;
  url?: string;
  thumbUrl?: string;
  durationSec?: number;
  text?: string;
  attribution?: string;
  useWhen: string;
  proves: string;
  oneLine: string;
  claims: string[];
  forSegment: string[];
  answers: string[];
  tags: string[];
  channels: string[];
  requiresApproval: boolean;
  expiresOn?: string;
  status: string;
  access?: {
    bookingUrl?: string;
    repName?: string;
    repRole?: string;
    repEmail?: string;
    repPhone?: string;
    availability?: string;
  };
}

/** Kinds that are the words themselves rather than a file to point at. */
const WORDS = ["quote", "stat"];

/**
 * The form is ordered the way an asset is decided on, not the way it is stored: what it is,
 * then when to use it, then who it is for, then what it is not allowed to do.
 *
 * The three sentences sit in their own group and are the only required fields besides the
 * name. Everything else has a defensible default; those three cannot, because they are
 * what a session reads to choose between two files it cannot open.
 */
export default function AssetDrawer({
  productId,
  action,
  segmentKeys,
  channelKeys,
  existing,
}: {
  productId: string;
  action: (formData: FormData) => void | Promise<void>;
  segmentKeys: string[];
  channelKeys: string[];
  existing?: AssetDraft;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(existing?.kind ?? "image");
  const isEdit = Boolean(existing);
  const words = WORDS.includes(kind);
  const access = kind === "access";

  return (
    <>
      <Button
        variant={isEdit ? "quiet" : undefined}
        size={isEdit ? "sm" : "md"}
        icon={isEdit ? <Pencil /> : <Plus />}
        onClick={() => setOpen(true)}
        aria-label={isEdit ? "Edit asset" : undefined}
      >
        {isEdit ? null : "New asset"}
      </Button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={isEdit ? `Edit ${existing?.name}` : "New asset"}
        description="Something to show a person that is not sentences. Claude picks it by what you write here."
        width={520}
      >
        <form action={action} className="stack">
          <input type="hidden" name="productId" value={productId} />
          {isEdit && <input type="hidden" name="assetId" value={existing?.id} />}

          <label>
            Name
            <input name="name" defaultValue={existing?.name} placeholder="90-second product demo" required />
            {isEdit && <span className="reason">Key stays <code>{existing?.key}</code> — rationales refer to it.</span>}
          </label>

          <div className="grid">
            <label>
              Kind
              <Select
                name="kind"
                value={kind}
                onValueChange={setKind}
                ariaLabel="Kind of asset"
                options={[
                  { value: "image", label: "Image" },
                  { value: "video", label: "Video" },
                  { value: "document", label: "Document" },
                  { value: "link", label: "Link" },
                  { value: "quote", label: "Quote" },
                  { value: "stat", label: "Stat" },
                  { value: "access", label: "Access", hint: "how to reach us" },
                ]}
              />
            </label>
            <label>
              Tier
              <Select
                name="tier"
                value={existing?.tier ?? (access ? "A" : "C")}
                ariaLabel="What this asset asks of the reader"
                options={[
                  { value: "D", label: "D — ambient", hint: "costs a glance" },
                  { value: "C", label: "C — generic", hint: "reads in a minute" },
                  { value: "B", label: "B — invested", hint: "asks for attention" },
                  { value: "A", label: "A — personal", hint: "asks for trust" },
                ]}
              />
            </label>
          </div>

          {!words && !access && (
            <>
              <label>
                File or page URL
                <input name="url" type="url" defaultValue={existing?.url} placeholder="https://…" required />
              </label>
              <div className="grid">
                <label>
                  Thumbnail <span className="muted">— inboxes will not play video</span>
                  <input name="thumbUrl" type="url" defaultValue={existing?.thumbUrl} placeholder="https://…" />
                </label>
                <label>
                  Length (seconds)
                  <input name="durationSec" type="number" min={1} defaultValue={existing?.durationSec} />
                </label>
              </div>
            </>
          )}

          {words && (
            <>
              <label>
                The words themselves
                <textarea name="text" defaultValue={existing?.text} required />
              </label>
              <label>
                Attribution
                <input name="attribution" defaultValue={existing?.attribution} placeholder="Ops lead, 40-person seller" />
              </label>
            </>
          )}

          {access && (
            <>
              <p className="reason">
                Held here rather than written into a template, so no message can carry it until a campaign
                unlocks the tier. The composer never sees these fields.
              </p>
              <label>
                Booking page
                <input name="bookingUrl" type="url" defaultValue={existing?.access?.bookingUrl} placeholder="https://…/book" />
              </label>
              <div className="grid">
                <label>
                  Who they meet
                  <input name="repName" defaultValue={existing?.access?.repName} placeholder="Dhaval" />
                </label>
                <label>
                  Their role
                  <input name="repRole" defaultValue={existing?.access?.repRole} placeholder="Founder" />
                </label>
              </div>
              <div className="grid">
                <label>
                  Reply-to
                  <input name="repEmail" type="email" defaultValue={existing?.access?.repEmail} />
                </label>
                <label>
                  Phone
                  <input name="repPhone" defaultValue={existing?.access?.repPhone} />
                </label>
              </div>
              <label>
                When they are reachable
                <input name="availability" defaultValue={existing?.access?.availability} placeholder="Weekdays, 10–6 IST" />
              </label>
            </>
          )}

          <label>
            Use when <span className="muted">— the condition, in your words</span>
            <input
              name="useWhen"
              defaultValue={existing?.useWhen}
              placeholder="They said the price is high and already spend on ads"
              required
            />
          </label>

          <label>
            It proves <span className="muted">— what they believe afterwards</span>
            <input
              name="proves"
              defaultValue={existing?.proves}
              placeholder="Payback lands inside one month at their ad spend"
              required
            />
          </label>

          <label>
            Introduce it as <span className="muted">— so the copy leading in is not written blind</span>
            <input
              name="oneLine"
              defaultValue={existing?.oneLine}
              placeholder="Ran the numbers for a seller at your volume"
              required
            />
          </label>

          <label>
            Claims it makes <span className="muted">— one per line</span>
            <textarea name="claims" defaultValue={existing?.claims.join("\n")} placeholder={"Payback under 30 days\nNo change to their listings"} />
            <span className="reason">
              Counted as already said, so a later message does not spend its best paragraph re-arguing this.
            </span>
          </label>

          <div className="grid">
            <label>
              For segments <span className="muted">— none means all</span>
              <MultiSelect
                name="forSegment"
                values={existing?.forSegment ?? []}
                placeholder="All segments"
                searchable={segmentKeys.length > 8}
                ariaLabel="Segments this asset may be shown to"
                options={segmentKeys.map((k) => ({ value: k, label: k }))}
              />
            </label>
            <label>
              Channels
              <MultiSelect
                name="channels"
                values={existing?.channels ?? ["email"]}
                placeholder="No channel"
                ariaLabel="Channels this asset may go out on"
                options={channelKeys.map((k) => ({ value: k, label: k }))}
              />
            </label>
          </div>

          <label>
            Objections it answers <span className="muted">— comma separated</span>
            <input name="answers" defaultValue={existing?.answers.join(", ")} placeholder="price, setup time" />
            <span className="reason">Matched against what this person actually pushed back on, which outranks how well it does on average.</span>
          </label>

          <label>
            Tags
            <input name="tags" defaultValue={existing?.tags.join(", ")} placeholder="demo, pricing" />
          </label>

          <div className="grid">
            <label>
              Expires on <span className="muted">— optional</span>
              <input name="expiresAt" type="date" defaultValue={existing?.expiresOn} />
            </label>
            <label>
              State
              <Select
                name="status"
                value={existing?.status ?? "draft"}
                ariaLabel="Asset state"
                options={[
                  { value: "draft", label: "Draft", hint: "never picked" },
                  { value: "active", label: "Active", hint: "may be picked" },
                  { value: "archived", label: "Archived" },
                ]}
              />
            </label>
          </div>

          <label className="check">
            <input type="checkbox" name="requiresApproval" defaultChecked={existing?.requiresApproval ?? access} />
            Hold any message carrying it for review
          </label>

          <SubmitButton pendingLabel={isEdit ? "Saving…" : "Adding…"}>
            {isEdit ? "Save changes" : "Add asset"}
          </SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
