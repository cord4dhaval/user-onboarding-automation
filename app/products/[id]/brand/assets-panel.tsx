import { ObjectId } from "mongodb";
import { Archive, Undo2 } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { rate } from "@/engine/engagement.js";
import { deleteAsset, saveAsset, setAssetStatus } from "../../../actions";
import { requireSession, scope } from "../../../tenant";
import { ActionButton } from "../../../ui/kit";
import ConfirmButton from "../../../ui/confirm";
import { ist, istDay, istInputValue } from "../../../ui/time";
import AssetDrawer, { type AssetDraft } from "./asset-drawer";
import { AssetThumb } from "./asset-preview";

/** What each tier is asking of the reader, said once, where somebody choosing one can read it. */
const TIER_NOTE: Record<string, string> = {
  D: "costs a glance",
  C: "reads in a minute",
  B: "asks for attention",
  A: "asks for trust",
};

const iso = (value: unknown) => (value ? new Date(String(value)).toISOString() : undefined);

/** The showable half of Brand: everything a message may point at that is not sentences. */
export default async function AssetsPanel({ id }: { id: string }) {
  const { orgId } = await requireSession();
  const db = await getDb();
  const s = scope(orgId, id);

  const [assets, product, channels] = await Promise.all([
    db.collection(C.assets).find(s).sort({ status: 1, tier: 1, name: 1 }).toArray(),
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }),
    db.collection(C.channels).find({ ...s, enabled: true }).toArray(),
  ]);

  const config = (product?.config ?? {}) as { segments?: Array<{ key: string }> };
  const segmentKeys = (config.segments ?? []).map((segment) => segment.key);
  const channelKeys = channels.map((channel) => String(channel.key));
  const live = assets.filter((a) => a.status === "active").length;
  const waiting = assets.filter((a) => (a.description as { state?: string } | undefined)?.state === "waiting").length;

  return (
    <>
      <header className="page-head">
        <div>
          <p className="sub">
            Everything we can show someone that is not sentences — a screenshot, a demo, a price sheet, a way to
            reach you. Add a name and the file; Claude looks at it and writes when to use it. Claude never writes a
            link or a phone number into a message: it picks from here, and only from what this person&apos;s
            segment, temperature and history allow.
          </p>
        </div>
        <AssetDrawer
          productId={id}
          action={saveAsset}
          segmentKeys={segmentKeys}
          channelKeys={channelKeys.length ? channelKeys : ["email"]}
        />
      </header>

      {assets.length === 0 ? (
        <p className="empty">
          <strong>No assets yet.</strong>
          Until there is one, every message is words alone. Upload the screenshot or demo you already send by hand;
          Claude writes when to use it.
        </p>
      ) : (
        <>
          <p className="reason">
            {live} of {assets.length} active
            {waiting > 0 ? `, ${waiting} waiting for Claude to describe them` : ""}. Drafts, archived assets and
            assets not yet described are never offered to a campaign.
          </p>

          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>When to use it</th>
                  <th>Aimed at</th>
                  <th>Carried by</th>
                  <th>What it earned</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => {
                  const usage = (a.usage ?? {}) as { sent?: number; clicked?: number; ledToGoal?: number };
                  const sent = Number(usage.sent ?? 0);
                  const segments = ((a.forSegment ?? []) as unknown[]).map(String);
                  const answers = ((a.answers ?? []) as unknown[]).map(String);
                  const carriers = ((a.channels ?? []) as unknown[]).map(String);
                  const expiresAt = a.expiresAt ? new Date(String(a.expiresAt)) : null;
                  const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
                  const archived = a.status === "archived";
                  const file = (a.file ?? {}) as { url?: string; fileId?: string; mime?: string; bytes?: number; thumbUrl?: string; durationSec?: number };
                  const description = (a.description ?? undefined) as
                    | { state: string; by?: string; requestedAt?: Date; doneAt?: Date; note?: string; autoTier?: boolean }
                    | undefined;
                  const access = (a.access ?? undefined) as AssetDraft["access"];
                  const draft: AssetDraft = {
                    id: String(a._id),
                    key: String(a.key),
                    name: String(a.name),
                    kind: String(a.kind),
                    tier: String(a.tier),
                    url: file.url,
                    fileId: file.fileId,
                    mime: file.mime,
                    bytes: file.bytes,
                    thumbUrl: file.thumbUrl,
                    durationSec: file.durationSec,
                    text: a.text ? String(a.text) : undefined,
                    attribution: a.attribution ? String(a.attribution) : undefined,
                    useWhen: String(a.useWhen ?? ""),
                    proves: String(a.proves ?? ""),
                    oneLine: String(a.oneLine ?? ""),
                    claims: ((a.claims ?? []) as unknown[]).map(String),
                    forSegment: segments,
                    answers,
                    tags: ((a.tags ?? []) as unknown[]).map(String),
                    channels: carriers,
                    requiresApproval: Boolean(a.requiresApproval),
                    // The date input wants a calendar day, and the stored instant is the
                    // end of that day in IST — so it has to be read back in IST too.
                    expiresOn: expiresAt ? istInputValue(expiresAt).slice(0, 10) : undefined,
                    status: String(a.status),
                    description: description
                      ? { ...description, requestedAt: iso(description.requestedAt), doneAt: iso(description.doneAt) }
                      : undefined,
                    access,
                  };

                  return (
                    <tr key={String(a._id)}>
                      <td>
                        <div className="asset-cell">
                          <AssetThumb
                            asset={{
                              name: draft.name,
                              kind: draft.kind,
                              url: draft.url,
                              thumbUrl: draft.thumbUrl,
                              mime: draft.mime,
                              bytes: draft.bytes,
                              text: draft.text,
                              attribution: draft.attribution,
                              oneLine: draft.oneLine,
                              bookingUrl: access?.bookingUrl,
                              availability: access?.availability,
                            }}
                          />
                          <div>
                            <span className="strong-link">{draft.name}</span>
                            <span className="cell-sub">
                              <code>{draft.key}</code>
                              <span className="pill accent">{draft.kind}</span>
                              <span className="pill">
                                {draft.tier} — {TIER_NOTE[draft.tier]}
                              </span>
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* The two sentences a session actually chooses on — or, until they
                          exist, the fact that they are owed and since when. A blank cell
                          here used to look exactly like a finished one. */}
                      <td className="cell-wide">
                        {description?.state === "waiting" ? (
                          <>
                            <span className="pill warm">Claude is describing it</span>
                            <span className="cell-sub">
                              asked {ist(description.requestedAt)} · not offered until it is done
                            </span>
                          </>
                        ) : description?.state === "failed" ? (
                          <>
                            <span className="pill bad">Needs a person</span>
                            <span className="cell-sub">{description.note ?? "Claude could not describe it."}</span>
                          </>
                        ) : (
                          <>
                            <span className="clamp">{draft.useWhen || "—"}</span>
                            <span className="cell-sub">
                              proves: {draft.proves || "—"}
                              {description?.by === "claude" ? " · written by Claude" : ""}
                            </span>
                          </>
                        )}
                      </td>

                      <td>
                        {segments.length ? (
                          <div className="row">
                            {segments.map((k) => <span key={k} className="pill">{k}</span>)}
                          </div>
                        ) : (
                          <span className="muted">every segment</span>
                        )}
                        {answers.length > 0 && (
                          <span className="cell-sub">answers: {answers.join(", ")}</span>
                        )}
                      </td>

                      <td>
                        {carriers.length ? carriers.join(", ") : <span className="muted">every channel</span>}
                        <span className="cell-sub">
                          {draft.requiresApproval && <span className="pill warm">held for review</span>}
                          {expiresAt && (
                            <span className={`pill ${expired ? "bad" : ""}`}>
                              {expired ? "expired" : `until ${istDay(expiresAt)}`}
                            </span>
                          )}
                        </span>
                      </td>

                      {/* An asset nobody has sent reads as new, not as failing. The two look
                          identical in a raw rate, and the difference decides whether it is
                          worth another send. */}
                      <td className="num">
                        {sent === 0 ? (
                          <span className="muted">not sent yet</span>
                        ) : (
                          <>
                            {rate(Number(usage.ledToGoal ?? 0), sent)} led to the goal
                            <div className="muted">
                              {sent} sent · {Number(usage.clicked ?? 0)} clicked
                            </div>
                          </>
                        )}
                      </td>

                      <td>
                        <div className="row">
                          <span className={`pill ${a.status === "active" ? "ok" : ""}`}>{String(a.status)}</span>
                          <AssetDrawer
                            productId={id}
                            action={saveAsset}
                            segmentKeys={segmentKeys}
                            channelKeys={channelKeys.length ? channelKeys : ["email"]}
                            existing={draft}
                          />
                          <ActionButton
                            variant="quiet"
                            size="sm"
                            icon={archived ? <Undo2 /> : <Archive />}
                            action={setAssetStatus.bind(null, id, draft.id, archived ? "active" : "archived")}
                            aria-label={archived ? "Restore asset" : "Archive asset"}
                            title={archived ? "Restore" : "Archive"}
                          />
                          <ConfirmButton
                            variant="quiet"
                            title={`Delete ${draft.name}?`}
                            body={
                              <>
                                It leaves every future menu immediately, and an uploaded file is deleted with it.
                                Messages already waiting in Review still name it, so if any do it is archived
                                instead of deleted and those messages stay whole.
                              </>
                            }
                            action={deleteAsset.bind(null, id, draft.id)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
