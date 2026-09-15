"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { ImageUp, Pencil, Plus } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button, SubmitButton } from "../../../ui/kit";
import Select, { MultiSelect } from "../../../ui/select";
import { AssetMedia } from "./asset-preview";

export interface AssetDraft {
  id: string;
  key: string;
  name: string;
  kind: string;
  tier: string;
  url?: string;
  fileId?: string;
  mime?: string;
  bytes?: number;
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
  description?: {
    state: string;
    by?: string;
    requestedAt?: string;
    doneAt?: string;
    note?: string;
    autoTier?: boolean;
  };
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

/** Kept in step with `KIND_BY_MIME` in src/engine/assetFiles.ts, which the server enforces. */
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4";
const MAX_BYTES = 4 * 1024 * 1024;

function kindForMime(mime: string): string | null {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "document";
  if (mime === "video/mp4") return "video";
  return null;
}

/** What the collapsed section says about the sentences, so its state is readable while closed. */
function describedLine(existing?: AssetDraft): string {
  const d = existing?.description;
  if (!existing) return "Leave these empty. After you save, Claude looks at the file and writes them within the hour.";
  if (d?.state === "waiting") return "Claude has not written these yet. It will within the hour; until then the asset is not offered.";
  if (d?.state === "failed") return `Claude flagged this asset: ${d.note ?? "no reason given"}`;
  if (d?.by === "claude") return "Written by Claude after looking at the file. Change anything that reads wrong.";
  return "Written by a person.";
}

/**
 * Adding an asset asks for three things: a name, the file, and whether it may be used.
 *
 * Everything else a composer needs — when to use it, what it proves, the line that
 * introduces it, who it is for — is written by a Claude routine that looks at the file, and
 * sits folded away under "What Claude wrote" for anyone who wants to check or correct it.
 * The form used to ask a person to type those sentences for a picture the form could not
 * even show them.
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
  const [picked, setPicked] = useState<{ url: string; mime: string; name: string; bytes: number } | null>(null);
  const [link, setLink] = useState(existing?.url ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const isEdit = Boolean(existing);
  const words = WORDS.includes(kind);
  const access = kind === "access";
  const carriesFile = !words && !access;

  // A preview URL made from a picked file holds the file in memory until it is released.
  useEffect(() => () => {
    if (picked) URL.revokeObjectURL(picked.url);
  }, [picked]);

  function close() {
    setOpen(false);
    setPicked(null);
    setProblem(null);
  }

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setProblem(null);
    if (!file) {
      setPicked(null);
      return;
    }
    const detected = kindForMime(file.type);
    const refuse = (reason: string) => {
      setProblem(reason);
      setPicked(null);
      event.target.value = "";
    };
    if (!detected) return refuse(`${file.name} cannot be sent in an email. Upload a PNG, JPEG, WebP, GIF, PDF or MP4.`);
    if (file.size > MAX_BYTES) {
      return refuse(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 4 MB; paste a link for anything larger.`);
    }
    setKind(detected);
    setPicked({ url: URL.createObjectURL(file), mime: file.type, name: file.name, bytes: file.size });
  }

  function guard(event: FormEvent<HTMLFormElement>) {
    if (carriesFile && !picked && !link.trim()) {
      event.preventDefault();
      setProblem("Add a file or paste a link to one.");
    }
  }

  const shown = picked
    ? { name: picked.name, kind, url: picked.url, mime: picked.mime, bytes: picked.bytes }
    : link.trim()
      ? { name: existing?.name ?? "", kind, url: link.trim(), mime: existing?.url === link.trim() ? existing?.mime : undefined, thumbUrl: existing?.thumbUrl, oneLine: existing?.oneLine }
      : null;

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
        onClose={close}
        title={isEdit ? `Edit ${existing?.name}` : "New asset"}
        description="A name and the file. Claude looks at it and writes when to use it."
        width={560}
      >
        <form action={action} onSubmit={guard} className="stack">
          <input type="hidden" name="productId" value={productId} />
          {isEdit && <input type="hidden" name="assetId" value={existing?.id} />}

          <label>
            Name
            <input name="name" defaultValue={existing?.name} placeholder="Where the hours went" required />
            {isEdit && <span className="reason">Key stays <code>{existing?.key}</code>, because earlier plans refer to it.</span>}
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
              State
              <Select
                name="status"
                value={existing?.status ?? "draft"}
                ariaLabel="Asset state"
                options={[
                  { value: "draft", label: "Draft", hint: "never offered" },
                  { value: "active", label: "Active", hint: "offered once described" },
                  { value: "archived", label: "Archived" },
                ]}
              />
            </label>
          </div>

          {carriesFile && (
            <div className="asset-file">
              {shown ? (
                <div className="asset-file-preview">
                  <AssetMedia asset={shown} size="full" />
                </div>
              ) : (
                <p className="asset-file-empty muted">Nothing to preview yet.</p>
              )}

              <label className="asset-drop">
                <ImageUp aria-hidden="true" />
                <span>
                  {picked ? `Replace ${picked.name}` : existing?.fileId ? "Replace the uploaded file" : "Upload a file"}
                  <span className="muted"> — PNG, JPEG, WebP, GIF, PDF or MP4, up to 4 MB</span>
                </span>
                <input type="file" name="file" accept={ACCEPT} onChange={pick} />
              </label>

              <label>
                Or paste a link
                <input
                  name="url"
                  type="url"
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  placeholder="https://…"
                  disabled={Boolean(picked)}
                />
              </label>

              {kind === "video" && (
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
              )}
            </div>
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
                  <input name="repName" defaultValue={existing?.access?.repName} />
                </label>
                <label>
                  Their role
                  <input name="repRole" defaultValue={existing?.access?.repRole} />
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

          {problem && (
            <p className="asset-problem" role="alert">
              {problem}
            </p>
          )}

          {/* Collapsed, not removed: the sentences are still the thing a composer chooses on,
              and a person who disagrees with what Claude wrote has to be able to fix it. Inputs
              inside a closed details element still post with the form. */}
          <details className="asset-more" open={existing?.description?.state === "failed"}>
            <summary>
              What Claude wrote
              <span className="reason">{describedLine(existing)}</span>
            </summary>

            <div className="asset-more-body">
              <label>
                Use when <span className="muted">— the reader and the moment it suits</span>
                <input name="useWhen" defaultValue={existing?.useWhen} />
              </label>

              <label>
                It proves <span className="muted">— what they believe afterwards</span>
                <input name="proves" defaultValue={existing?.proves} />
              </label>

              <label>
                Introduce it as <span className="muted">— printed to the reader as alt text or link words</span>
                <input name="oneLine" defaultValue={existing?.oneLine} />
              </label>

              <label>
                Claims it makes <span className="muted">— one per line</span>
                <textarea name="claims" defaultValue={existing?.claims.join("\n")} />
                <span className="reason">Counted as already said, so a later message does not repeat it.</span>
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
                <input name="answers" defaultValue={existing?.answers.join(", ")} />
              </label>

              <label>
                Tags
                <input name="tags" defaultValue={existing?.tags.join(", ")} />
              </label>

              <div className="grid">
                <label>
                  Tier
                  <Select
                    name="tier"
                    value={existing && !existing.description?.autoTier ? existing.tier : ""}
                    ariaLabel="What this asset asks of the reader"
                    options={[
                      { value: "", label: "Automatic", hint: "from the kind, then Claude" },
                      { value: "D", label: "D — ambient", hint: "costs a glance" },
                      { value: "C", label: "C — generic", hint: "reads in a minute" },
                      { value: "B", label: "B — invested", hint: "asks for attention" },
                      { value: "A", label: "A — personal", hint: "asks for trust" },
                    ]}
                  />
                </label>
                <label>
                  Expires on <span className="muted">— optional</span>
                  <input name="expiresAt" type="date" defaultValue={existing?.expiresOn} />
                </label>
              </div>

              <label className="check">
                <input type="checkbox" name="requiresApproval" defaultChecked={existing?.requiresApproval ?? access} />
                Hold any message carrying it for review
              </label>
            </div>
          </details>

          <SubmitButton pendingLabel={picked ? "Uploading…" : isEdit ? "Saving…" : "Adding…"}>
            {isEdit ? "Save changes" : "Add asset"}
          </SubmitButton>
        </form>
      </Drawer>
    </>
  );
}
