"use client";

import { useState, type ReactNode } from "react";
import { CalendarClock, FileText, Link2, Quote, Video } from "lucide-react";
import Drawer from "../../../ui/drawer";
import { Button } from "../../../ui/kit";

/** Everything a preview needs, and nothing a preview could leak: no rep phone, no calendar ids. */
export interface PreviewableAsset {
  name: string;
  kind: string;
  url?: string;
  thumbUrl?: string;
  mime?: string;
  bytes?: number;
  text?: string;
  attribution?: string;
  oneLine?: string;
  bookingUrl?: string;
  availability?: string;
}

const KIND_LABEL: Record<string, string> = {
  image: "Image",
  video: "Video",
  document: "Document",
  link: "Link",
  quote: "Quote",
  stat: "Stat",
  access: "Booking",
};

function isPdf(asset: PreviewableAsset): boolean {
  return asset.mime === "application/pdf" || /\.pdf($|\?)/i.test(asset.url ?? "");
}

function isPlayable(asset: PreviewableAsset): boolean {
  return Boolean(asset.mime?.startsWith("video/") || /\.(mp4|webm|mov)($|\?)/i.test(asset.url ?? ""));
}

function size(bytes?: number): string | null {
  if (!bytes) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The asset itself, at thumbnail or full size.
 *
 * Words-only kinds render the way the email renders them — a stat or a quote as the
 * callout a reader sees — so the preview answers "what will they get", not "what is stored".
 */
export function AssetMedia({ asset, size: at }: { asset: PreviewableAsset; size: "thumb" | "full" }) {
  const media = at === "thumb" ? "asset-media-thumb" : "asset-media-full";
  const icon = (glyph: ReactNode) => <span className="asset-media-icon">{glyph}</span>;

  if (asset.kind === "image" && asset.url) {
    // A plain img, not next/image: these are arbitrary hosts and uploaded files, and the
    // optimiser would need every one of them allow-listed to show a thumbnail.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.url} alt={asset.oneLine || asset.name} className={media} loading="lazy" />;
  }

  if (asset.kind === "video") {
    if (at === "full" && asset.url && isPlayable(asset)) {
      return <video src={asset.url} poster={asset.thumbUrl} controls className={media} />;
    }
    // eslint-disable-next-line @next/next/no-img-element
    if (asset.thumbUrl) return <img src={asset.thumbUrl} alt="" className={media} loading="lazy" />;
    return icon(<Video />);
  }

  if (asset.kind === "document") {
    if (at === "full" && asset.url && isPdf(asset)) {
      return <iframe src={asset.url} title={asset.name} className="asset-media-frame" />;
    }
    return icon(<FileText />);
  }

  if (asset.kind === "stat" || asset.kind === "quote") {
    if (at === "thumb") return icon(<Quote />);
    const body = asset.kind === "quote" ? `“${asset.text ?? ""}”` : (asset.text ?? "");
    return (
      <p className="asset-callout">
        {body}
        {asset.attribution ? ` — ${asset.attribution}` : ""}
      </p>
    );
  }

  if (asset.kind === "access") {
    if (at === "thumb") return icon(<CalendarClock />);
    return (
      <p className="asset-callout">
        {asset.oneLine || "A booking link"}
        {asset.availability ? ` · ${asset.availability}` : ""}
      </p>
    );
  }

  if (at === "thumb") return icon(<Link2 />);
  return (
    <p className="asset-callout">
      <a href={asset.url} target="_blank" rel="noreferrer">
        {asset.oneLine || asset.url}
      </a>
    </p>
  );
}

/** A thumbnail in the list that opens the full preview beside it. */
export function AssetThumb({ asset }: { asset: PreviewableAsset }) {
  const [open, setOpen] = useState(false);
  const facts = [KIND_LABEL[asset.kind] ?? asset.kind, asset.mime, size(asset.bytes)].filter(Boolean).join(" · ");

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="asset-thumb"
        onClick={() => setOpen(true)}
        aria-label={`Preview ${asset.name}`}
        title="Preview"
      >
        <AssetMedia asset={asset} size="thumb" />
      </Button>

      <Drawer open={open} onClose={() => setOpen(false)} title={asset.name} description="As a reader receives it." width={640}>
        <div className="asset-preview">
          <AssetMedia asset={asset} size="full" />
          {asset.oneLine && ["image", "video", "document"].includes(asset.kind) && (
            <p className="reason">Introduced in the email as: {asset.oneLine}</p>
          )}
          <p className="cell-sub">
            {facts}
            {asset.url && (
              <a href={asset.url} target="_blank" rel="noreferrer">
                Open the original
              </a>
            )}
          </p>
        </div>
      </Drawer>
    </>
  );
}
