import type { ResolvedBlock, ResolvedTemplate } from "./compose.js";
import type { ResolvedKit } from "./brand.js";

/**
 * Renders a resolved template into email HTML, in the product's own brand.
 *
 * Everything here is deliberately old-fashioned — tables, inline styles, no flexbox, no
 * external assets. Mail clients are not browsers, and a layout that only looks right in
 * one of them is worse than a plain one that looks right in all of them.
 *
 * The design decisions that make a message read as considered rather than generated are
 * fixed here rather than left to a model: one accent, a real type scale, generous vertical
 * rhythm, a single call to action, and a footer that says who is writing.
 */
export function renderHtml(resolved: ResolvedTemplate, brand: ResolvedKit): string {
  // A brand sheet supplies an accent far more often than it supplies the colour of text
  // sitting on it. Left alone that produces white on pale teal, which is the single most
  // common way branded mail ends up with an unreadable button.
  const light = { ...brand.color, accentText: readableOn(brand.color.accent, brand.color.accentText) };
  const dark = { ...darkFrom(light), ...(brand.darkColor ?? {}) };
  const font = brand.font;
  const shape = brand.shape;
  const [h1, h2, h3, body, small] = font.scale;

  const preheader = resolved.blocks.find((b) => b.kind === "preheader");
  const rows: string[] = [];
  let ctaSeen = false;

  for (const block of resolved.blocks) {
    switch (block.kind) {
      case "preheader":
        break;

      case "heading": {
        const size = block.level === 1 ? h1 : block.level === 2 ? h2 : h3;
        rows.push(row(`
          <h${block.level} class="dm-ink" style="margin:0;font-family:${attr(font.headingStack)};font-size:${size}px;line-height:${font.headingLeading};font-weight:${font.headingWeight};letter-spacing:-0.02em;color:${light.text};">${inline(block.text)}</h${block.level}>
        `, shape.space));
        break;
      }

      case "text":
        rows.push(row(paragraphs(block.text, light, font, body), shape.space));
        break;

      case "list":
        rows.push(row(list(block, light, font, body), shape.space));
        break;

      case "card":
        rows.push(row(card(block, light, font, body, small, shape), shape.space));
        break;

      case "callout":
        rows.push(row(`
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="dm-soft" style="background:${tint(light.accent)};border-radius:${shape.radius}px;padding:16px 18px;font-family:${attr(font.bodyStack)};font-size:${body - 1}px;line-height:${font.bodyLeading};color:${light.text};">${inline(block.text)}</td>
          </tr></table>
        `, shape.space));
        break;

      case "divider":
        rows.push(row(`
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="dm-rule" style="border-top:1px solid ${light.border};font-size:0;line-height:0;">&nbsp;</td>
          </tr></table>
        `, shape.space));
        break;

      case "image": {
        const width = Math.min(block.width ?? 600 - shape.pad * 2, 600 - shape.pad * 2);
        const img = `<img src="${attr(block.url)}" alt="${attr(block.alt)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;border-radius:${shape.radius}px;" />`;
        rows.push(row(block.href ? `<a href="${attr(block.href)}" style="text-decoration:none;">${img}</a>` : img, shape.space));
        break;
      }

      case "cta":
        // One button carries the message. A second is a second decision, and a reader who
        // has to make two usually makes neither.
        if (ctaSeen) {
          rows.push(row(`
            <p style="margin:0;font-family:${attr(font.bodyStack)};font-size:${body}px;line-height:${font.bodyLeading};color:${light.text};"><a href="${attr(block.url)}" style="color:${light.accent};font-weight:600;">${inline(block.text)}</a></p>
          `, shape.space));
        } else {
          rows.push(row(button(block, light, font, shape, body), shape.space + 6));
          ctaSeen = true;
        }
        break;

      case "optout":
        rows.push(footer(block.url, brand, light, small));
        break;
    }
  }

  const logoRow = brand.logo
    ? row(logo(brand), shape.space + 6)
    : brand.footer.legalName
      ? row(`<p class="dm-ink" style="margin:0;font-family:${attr(font.headingStack)};font-size:${h3}px;font-weight:${font.headingWeight};letter-spacing:-0.01em;color:${light.text};">${esc(brand.footer.legalName)}</p>`, shape.space + 6)
      : "";

  const topRule = shape.topRule
    ? `<tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:${light.accent};${gradientCss(light)}">&nbsp;</td></tr>`
    : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${esc(resolved.subject ?? "")}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
  a:not(.cta){color:${light.accent};}
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;}
    .pad{padding-left:22px !important;padding-right:22px !important;}
    .h1{font-size:${Math.round(h1 * 0.8)}px !important;}
  }
  @media (prefers-color-scheme:dark){
    .dm-ground{background:${dark.bg} !important;}
    .dm-card{background:${dark.surface} !important;}
    .dm-ink{color:${dark.text} !important;}
    .dm-muted{color:${dark.muted} !important;}
    .dm-rule{border-color:${dark.border} !important;}
    .dm-soft{background:${tint(dark.accent, true)} !important;color:${dark.text} !important;}
    /* The button is an anchor too. Without this exclusion the link colour repaints its
       label in the accent, on the accent, and the words disappear. */
    a:not(.cta){color:${dark.accent} !important;}
    .cta{background:${dark.accent} !important;color:${dark.accentText} !important;}
  }
</style>
</head>
<body class="dm-ground" style="margin:0;padding:0;background:${light.bg};">
${preheaderHtml(preheader)}
<table role="presentation" class="dm-ground" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${light.bg};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" class="wrap dm-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${light.surface};border-radius:${shape.radius + 4}px;overflow:hidden;box-shadow:0 1px 2px rgba(16,17,20,.04),0 18px 44px -32px rgba(16,17,20,.35);">
      ${topRule}
      <tr><td class="pad" style="padding:${shape.pad}px ${shape.pad}px ${shape.pad - 8}px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${logoRow}
          ${rows.join("\n")}
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * The letter format: HTML that reads like an email a person typed.
 *
 * Plain text cannot bold a word or hide a tracked link behind its label; the designed email
 * can, but it looks like marketing, and plain mail draws more clicks than designed mail
 * (HubSpot's tests). Superhuman, Buffer and HEY send this middle shape: no logo, no card, no
 * button, no colours of our own. Only what an ordinary mail client would let a person do —
 * a bold phrase, a short list, a link on its words — so the reader sees a note and the
 * engine still gets bold emphasis, a clean link and click tracking.
 *
 * Colours are the ones a typed Gmail message has: dark grey text on white, blue links. They
 * used to be left to the client with a "light dark" colour scheme declared, and any viewer on
 * a dark screen that honours that declaration (the review preview, some web mail) painted the
 * whole note black. Mail apps with their own dark mode still darken it the way they darken a
 * person's mail.
 */
/** What a letter carries of the brand: the name, the logo mark, the accent and a signature line. */
export interface LetterBrand {
  name: string;
  logoUrl?: string;
  accent: string;
  tagline?: string;
  website?: string;
}

/** The letter's brand from the product's brand kit and config, so any product's letters wear its own. */
export function letterBrandFrom(kit: ResolvedKit, product?: Record<string, unknown> | null): LetterBrand {
  const config = (product?.config ?? {}) as { website?: unknown; writing?: { signatureLine?: unknown } };
  return {
    name: String(kit.footer.legalName || product?.name || kit.logo?.alt || ""),
    logoUrl: kit.logo?.light || undefined,
    accent: kit.color.accent,
    tagline: typeof config.writing?.signatureLine === "string" ? config.writing.signatureLine : undefined,
    website: typeof config.website === "string" ? config.website : undefined,
  };
}

export function renderLetter(resolved: ResolvedTemplate, brand?: LetterBrand): string {
  const preheader = resolved.blocks.find((b) => b.kind === "preheader");
  const para = (inner: string, margin = 16) => `<p style="margin:0 0 ${margin}px;">${inner}</p>`;
  const out: string[] = [];
  // The accent as the ticks and lines use it, and a darker shade of it where text or a
  // button needs to be read against white.
  const accent = brand?.accent || "#1a73e8";
  const ink = inkOf(accent);
  const name = brand?.name?.trim() || "";
  const logo = (size: number, radius: number) =>
    brand?.logoUrl
      ? `<img src="${attr(brand.logoUrl)}" width="${size}" height="${size}" alt="${attr(name)}" style="display:block;border:0;border-radius:${radius}px;" />`
      : "";
  const withName = (html: string) =>
    name ? html.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), `<strong style="color:${ink};">${esc(name)}</strong>`) : html;

  // Dhaval chose the layout on 2026-09-17: the logo and name on top, the part about the
  // product set between two thin lines with its name in the accent, one button, and the
  // logo again in the signature. The problem stays in black bold, so the reader sees the
  // problem and then the answer.
  if (name) {
    out.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>${
        brand?.logoUrl ? `<td style="vertical-align:middle;padding:0 8px 0 0;">${logo(28, 6)}</td>` : ""
      }<td style="vertical-align:middle;font-size:17px;font-weight:700;color:#101114;">${esc(name)}</td></tr></table>`,
    );
  }

  const blocks = resolved.blocks;
  let signed = false;
  const signature = () => {
    if (signed || !name) return "";
    signed = true;
    const lines = [
      `<strong style="color:#101114;font-size:13px;">${esc(name)}</strong>`,
      brand?.tagline ? esc(brand.tagline) : "",
      brand?.website ? `<a href="${attr(brand.website)}" style="color:${ink};text-decoration:none;font-weight:700;">${esc(brand.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>` : "",
    ].filter(Boolean);
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tr>${
      brand?.logoUrl ? `<td style="vertical-align:top;padding:2px 10px 0 0;">${logo(32, 6)}</td>` : ""
    }<td style="vertical-align:top;font-size:12px;line-height:1.5;color:#5f6368;">${lines.join("<br />")}</td></tr></table>`;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    switch (block.kind) {
      case "preheader":
      case "divider":
        break;
      case "heading":
        out.push(para(`<strong>${inline(block.text)}</strong>`));
        break;
      case "callout":
        out.push(para(inline(block.text)));
        break;
      case "text": {
        const next = blocks[i + 1];
        // What they would see: the title and its list, set apart between two thin lines,
        // with the product's name in the accent.
        if (block.tight && next?.kind === "list" && next.fromParts && next.style === "receipt") {
          out.push(
            `<div style="margin:0 0 16px;padding:12px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">${sampleCard(block.text, next.items, ink)}</div>`,
          );
          i++;
          break;
        }
        if (block.tight && next?.kind === "list" && next.fromParts) {
          const items = next.items
            .map((item, k) => para(`<span style="color:${accent};font-weight:700;">&#10003;</span>&nbsp; ${inline(item)}`, k === next.items.length - 1 ? 0 : 4))
            .join("");
          out.push(
            `<div style="margin:0 0 16px;padding:12px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">${para(withName(inline(block.text)), 8)}${items}</div>`,
          );
          i++;
          break;
        }
        // The "no way" part: what the product already knows, set apart between two thin lines
        // with the product's name in the brand shade.
        if (block.slot === "reveal") {
          const lines = block.text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
          // A sample card that follows the reveal sits inside the same section: the claim, then
          // the sample that shows it.
          const title = blocks[i + 1];
          const card = blocks[i + 2];
          const withCard = title?.kind === "text" && title.tight && card?.kind === "list" && card.fromParts && card.style === "receipt";
          out.push(
            `<div style="margin:0 0 16px;padding:12px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">${lines
              .map((part, k) => para(withName(inline(part)), k === lines.length - 1 && !withCard ? 0 : 8))
              .join("")}${withCard ? sampleCard(title.text, card.items, ink) : ""}</div>`,
          );
          if (withCard) i += 2;
          break;
        }
        // The signature goes in front of the P.S., which is the last thing a reader reads.
        if (/^P\.S\./.test(block.text.trim())) out.push(signature());
        for (const part of block.text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
          out.push(para(inline(part), block.tight ? 4 : 16));
        }
        break;
      }
      case "list":
        out.push(
          `<ul style="margin:0 0 16px;padding:0 0 0 22px;">${block.items
            .map((item) => `<li style="margin:0 0 4px;">${block.style === "strike" ? `<s>${inline(item)}</s>` : inline(item)}</li>`)
            .join("")}</ul>`,
        );
        break;
      case "card": {
        const title = block.title ? para(inline(block.title), 4) : "";
        const rows = block.rows
          .map((r) =>
            block.fromParts
              ? para(`${inline(r.label)}${r.value ? `<br />&rarr; <strong>${inline(r.value)}</strong>` : ""}`, 10)
              : para(`${inline(r.label)}: <strong>${inline(r.value)}</strong>`, 6),
          )
          .join("");
        out.push(`<div style="margin:0 0 16px;">${title}${rows}</div>`);
        break;
      }
      case "image": {
        const img = `<img src="${attr(block.url)}" alt="${attr(block.alt)}" width="${Math.min(block.width ?? 560, 560)}" style="display:block;max-width:100%;height:auto;border:0;" />`;
        out.push(`<div style="margin:0 0 16px;">${block.href ? `<a href="${attr(block.href)}">${img}</a>` : img}</div>`);
        break;
      }
      case "cta":
        // One button in the brand's shade, the only thing in the letter asking to be pressed.
        out.push(
          para(
            `<a href="${attr(block.url)}" style="display:inline-block;background:${ink};color:#ffffff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:6px;">${inline(block.text)} &rarr;</a>`,
            20,
          ),
        );
        break;
      case "optout":
        out.push(signature());
        out.push(
          `<p style="margin:24px 0 0;font-size:12px;color:#5f6368;">Not useful? Reply "remove me", or <a href="${attr(block.url)}" style="color:#5f6368;">unsubscribe</a>.</p>`,
        );
        break;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(resolved.subject ?? "")}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${preheaderHtml(preheader)}
<div style="max-width:600px;padding:8px 4px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#202124;background:#ffffff;">
${out.join("\n")}
</div>
</body>
</html>`;
}

/**
 * A day-1 receipt in the designed format: the lines as they were written, in the body font.
 */
function receipt(lines: string[], accent: string): string {
  return sampleCard("", lines, accent);
}

type SampleRow =
  | { kind: "headline"; name: string; tracked: string; focus: string }
  | { kind: "total"; text: string }
  | { kind: "bar"; label: string; value: string; amount: number }
  | { kind: "timed"; at: string; what: string; value: string }
  | { kind: "labelled"; label: string; value: string }
  | { kind: "other"; text: string };

const minutesOf = (text: string): number | null => {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
};

/** Reads a sample card's lines ("Excel · 4h 53m", "09:04 standup · 18m", "Done: 214 …") into rows. */
export function sampleRows(lines: string[]): SampleRow[] {
  return lines.map((raw): SampleRow => {
    const line = raw.trim();
    let m = /^(?:(.+?)\s*·\s*)?(\d+h(?:\s*\d+m)?)\s+tracked\s*·\s*([\d.]+h)\s+(?:deep\s+)?focus$/i.exec(line);
    if (m) return { kind: "headline", name: m[1] ?? "", tracked: m[2]!, focus: m[3]! };
    m = /^(\d+h(?:\s*\d+m)?|\d+m)\s+active(?:\s*·\s*(\d+m)\s+idle)?$/i.exec(line);
    if (m) return { kind: "total", text: `${m[1]} active${m[2] ? ` · ${m[2]} idle` : ""}` };
    m = /^(\d{1,2})(?::(\d{2}))?\s*[–-]\s*(\d{1,2})(?::(\d{2}))?\s*·\s*(?:score\s*)?(\d{1,3})%$/i.exec(line);
    if (m) {
      const whole = (m[2] ?? "00") === "00" && (m[4] ?? "00") === "00";
      const label = whole ? `${m[1]}–${m[3]}` : line.split("·")[0]!.trim();
      return { kind: "bar", label, value: `${m[5]}%`, amount: Number(m[5]) };
    }
    m = /^(\d{1,2}:\d{2})\s+(.+?)\s*·\s*([^·]+)$/.exec(line);
    if (m && minutesOf(m[3]!) !== null) {
      const what = m[2]!.replace(/\s*·\s*/g, ", ");
      return { kind: "timed", at: m[1]!, what: what.charAt(0).toUpperCase() + what.slice(1), value: m[3]!.trim() };
    }
    m = /^(.+?)\s*·\s*([^·]+)$/.exec(line);
    if (m && minutesOf(m[2]!) !== null) return { kind: "bar", label: m[1]!, value: m[2]!.trim(), amount: minutesOf(m[2]!)! };
    m = /^([A-Z][A-Za-z]{2,11}):\s+(.+)$/.exec(line);
    if (m) return { kind: "labelled", label: m[1]!, value: m[2]! };
    return { kind: "other", text: line };
  });
}

/**
 * A sample card as a small piece of the product (Dhaval chose this look, 2026-09-17): a light
 * bordered card in the body font, the title as a small header with the day's total on the
 * right, and the lines laid out for what they are. Two headline figures for a summary, bars for
 * time per app or score per hour, a time list for a tracked day, and label rows for Done and
 * Stuck. Tables only, so it holds in Gmail and Outlook; the brand shade is the only colour.
 */
function sampleCard(title: string, lines: string[], ink: string): string {
  const rows = sampleRows(lines);
  const font = "font-family:Arial,Helvetica,sans-serif;";
  const rule = "border-top:1px solid #e5e7eb;";
  const headline = rows.find((r): r is Extract<SampleRow, { kind: "headline" }> => r.kind === "headline");
  const total = rows.find((r): r is Extract<SampleRow, { kind: "total" }> => r.kind === "total");
  const bars = rows.filter((r): r is Extract<SampleRow, { kind: "bar" }> => r.kind === "bar");
  const hourly = bars.length > 0 && bars.every((b) => b.value.endsWith("%"));
  const best = hourly ? bars.reduce((a, b) => (b.amount > a.amount ? b : a)) : null;
  const heading = [title.trim().replace(/:$/, "").replace(/^an?\s+/i, ""), headline?.name ?? ""].filter(Boolean).join(" · ").toUpperCase();
  const right = total ? total.text : best ? `Best: ${best.label}` : "";
  const parts: string[] = [];
  if (heading || right) {
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="${font}font-size:11px;letter-spacing:0.06em;color:#5f6368;">${inline(heading)}</td>${
        right ? `<td align="right" style="${font}font-size:12px;font-weight:700;color:${ink};white-space:nowrap;">${inline(right)}</td>` : ""
      }</tr></table>`,
    );
  }
  if (headline) {
    const figure = (value: string, label: string, color: string) =>
      `<td width="50%" valign="top" style="${font}"><div style="font-size:20px;line-height:1.2;font-weight:700;color:${color};">${inline(value)}</div><div style="font-size:12px;color:#5f6368;">${label}</div></td>`;
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 10px;"><tr>${figure(headline.tracked, "tracked", ink)}${figure(headline.focus, "deep focus", "#202124")}</tr></table>`);
  }
  if (bars.length) {
    const most = Math.max(...bars.map((b) => b.amount), 1);
    const scale = hourly ? 100 : most;
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 0;">${bars
        .map((b) => {
          const width = Math.max(3, Math.min(100, Math.round((b.amount * 100) / scale)));
          return `<tr><td width="30%" style="padding:6px 10px 6px 0;${font}font-size:13px;color:#202124;">${inline(b.label)}</td><td style="padding:6px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="#eef2f2" style="background:#eef2f2;border-radius:4px;font-size:0;line-height:0;"><table role="presentation" width="${width}%" cellpadding="0" cellspacing="0"><tr><td bgcolor="${ink}" height="10" style="background:${ink};height:10px;border-radius:4px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table></td><td width="64" align="right" style="padding:6px 0 6px 10px;${font}font-size:13px;font-weight:700;color:#202124;white-space:nowrap;">${inline(b.value)}</td></tr>`;
        })
        .join("")}</table>`,
    );
  }
  const listed = rows.filter((r) => r.kind === "timed" || r.kind === "labelled" || r.kind === "other");
  if (listed.length) {
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 0;">${listed
        .map((r) => {
          if (r.kind === "timed") {
            return `<tr><td width="52" style="padding:7px 0;${rule}${font}font-size:13px;color:#5f6368;">${inline(r.at)}</td><td style="padding:7px 8px 7px 0;${rule}${font}font-size:14px;color:#202124;">${inline(r.what)}</td><td align="right" style="padding:7px 0;${rule}${font}font-size:14px;font-weight:700;color:#202124;white-space:nowrap;">${inline(r.value)}</td></tr>`;
          }
          if (r.kind === "labelled") {
            return `<tr><td width="52" valign="top" style="padding:7px 0;${rule}${font}font-size:13px;color:#5f6368;">${inline(r.label)}</td><td colspan="2" style="padding:7px 0;${rule}${font}font-size:14px;color:#202124;">${inline(r.value)}</td></tr>`;
          }
          return `<tr><td colspan="3" style="padding:7px 0;${rule}${font}font-size:14px;color:#202124;">${inline((r as { text: string }).text)}</td></tr>`;
        })
        .join("")}</table>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;margin:4px 0 0;"><tr><td style="padding:12px 14px 8px;">${parts.join("")}</td></tr></table>`;
}

/** The accent darkened until white text on it, or it on white, reads at 4.5:1. */
function inkOf(accent: string): string {
  let [r, g, b] = rgb(accent);
  const hex = () => `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
  for (let step = 0; step < 16 && contrast(hex(), "#ffffff") < 4.5; step++) {
    r *= 0.9;
    g *= 0.9;
    b *= 0.9;
  }
  return hex();
}

// ── pieces ────────────────────────────────────────────────────────────────────

/** One vertical slot in the single-column stack. Spacing lives here, not in the blocks. */
function row(inner: string, space: number): string {
  return `<tr><td style="padding:0 0 ${space}px;">${inner.trim()}</td></tr>`;
}

function logo(brand: ResolvedKit): string {
  const l = brand.logo!;
  const img = `<img src="${attr(l.light)}" alt="${attr(l.alt || brand.footer.legalName)}" width="${l.width}" style="display:block;width:${l.width}px;max-width:${l.width}px;height:auto;border:0;" />`;
  return l.href ? `<a href="${attr(l.href)}" style="text-decoration:none;">${img}</a>` : img;
}

/**
 * A hidden line the inbox shows next to the subject. The trailing filler stops the client
 * from padding it out with the first words of the body, which is what makes most previews
 * read as an accident.
 */
function preheaderHtml(block: ResolvedBlock | undefined): string {
  if (!block || block.kind !== "preheader") return "";
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;height:0;width:0;">${esc(block.text)}${"&#8199;&#65279;&#847; ".repeat(30)}</div>`;
}

function paragraphs(
  text: string,
  color: ResolvedKit["color"],
  font: ResolvedKit["font"],
  size: number,
): string {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(
      (part, index) =>
        `<p class="dm-ink" style="margin:${index === 0 ? 0 : 14}px 0 0;font-family:${attr(font.bodyStack)};font-size:${size}px;line-height:${font.bodyLeading};color:${color.text};">${inline(part)}</p>`,
    )
    .join("");
}

function list(
  block: Extract<ResolvedBlock, { kind: "list" }>,
  color: ResolvedKit["color"],
  font: ResolvedKit["font"],
  size: number,
): string {
  if (block.style === "receipt") return receipt(block.items, color.accent);
  const items = block.items
    .map((item) => {
      const marker =
        block.style === "check"
          ? `<span style="color:${color.accent};font-weight:700;">&#10003;</span>`
          : block.style === "strike"
            ? `<span class="dm-muted" style="color:${color.muted};">&#8211;</span>`
            : `<span style="color:${color.accent};">&#8226;</span>`;
      // A struck-through line is the point of that style, so the text carries the rule.
      const inner =
        block.style === "strike"
          ? `<span class="dm-muted" style="color:${color.muted};text-decoration:line-through;">${inline(item)}</span>`
          : inline(item);
      return `<tr>
        <td width="22" valign="top" style="padding:0 0 10px;font-family:${attr(font.bodyStack)};font-size:${size}px;line-height:${font.bodyLeading};">${marker}</td>
        <td valign="top" class="dm-ink" style="padding:0 0 10px;font-family:${attr(font.bodyStack)};font-size:${size}px;line-height:${font.bodyLeading};color:${color.text};">${inner}</td>
      </tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>`;
}

function card(
  block: Extract<ResolvedBlock, { kind: "card" }>,
  color: ResolvedKit["color"],
  font: ResolvedKit["font"],
  size: number,
  small: number,
  shape: ResolvedKit["shape"],
): string {
  const title = block.title
    ? `<tr><td colspan="2" class="dm-ink" style="padding:0 0 14px;font-family:${attr(font.headingStack)};font-size:${size + 2}px;font-weight:${font.headingWeight};letter-spacing:-0.01em;color:${color.text};">${inline(block.title)}</td></tr>`
    : "";
  // In a written touch the label carries the example's numbers, so it reads at body size in
  // ink rather than as a small grey caption; a template's own card keeps the caption style.
  const labelStyle = block.fromParts
    ? `class="dm-ink" style="padding:0 0 2px;font-family:${attr(font.bodyStack)};font-size:${size - 1}px;line-height:1.45;color:${color.text};"`
    : `class="dm-muted" style="padding:0 0 4px;font-family:${attr(font.bodyStack)};font-size:${small}px;line-height:1.4;color:${color.muted};"`;
  const rows = block.rows
    .map(
      (r) => `<tr>
        <td ${labelStyle}>${inline(r.label)}</td>
      </tr>
      <tr>
        <td class="dm-ink" style="padding:0 0 14px;font-family:${attr(font.bodyStack)};font-size:${size}px;line-height:1.45;color:${color.text};font-weight:600;">${block.fromParts ? "→ " : ""}${inline(r.value)}</td>
      </tr>`,
    )
    .join("");
  const border = block.accent ? `border:1px solid ${color.accent};` : `border:1px solid ${color.border};`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td class="dm-soft dm-rule" style="background:${block.accent ? tint(color.accent) : "transparent"};${border}border-radius:${shape.radius}px;padding:20px 20px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${title}${rows}</table>
    </td>
  </tr></table>`;
}

/**
 * The button. Gradient where the brand has one, flat accent otherwise, and a VML shape so
 * Outlook shows a real button rather than a bare link — which is where most branded mail
 * quietly falls apart.
 */
function button(
  block: Extract<ResolvedBlock, { kind: "cta" }>,
  color: ResolvedKit["color"],
  font: ResolvedKit["font"],
  shape: ResolvedKit["shape"],
  size: number,
): string {
  const label = esc(block.text);
  const href = attr(block.url);
  const radius = shape.buttonRadius;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="${Math.min(50, Math.round((radius / 48) * 100))}%" stroke="f" fillcolor="${color.accent}">
  <w:anchorlock/>
  <center style="color:${color.accentText};font-family:Arial,sans-serif;font-size:${size}px;font-weight:bold;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${href}" class="cta" style="display:inline-block;background:${color.accent};${gradientCss(color)}color:${color.accentText};font-family:${attr(font.bodyStack)};font-size:${size}px;font-weight:600;line-height:1;text-decoration:none;padding:16px 30px;border-radius:${radius}px;mso-hide:all;">${label}&nbsp;&#8594;</a>
<!--<![endif]-->
</td></tr></table>`;
}

function footer(optOutUrl: string, brand: ResolvedKit, color: ResolvedKit["color"], small: number): string {
  const f = brand.footer;
  const font = brand.font;
  const social = f.social.length
    ? `<p style="margin:0 0 10px;font-family:${attr(font.bodyStack)};font-size:${small}px;">${f.social
        .map((s) => `<a href="${attr(s.url)}" style="color:${color.muted};text-decoration:underline;margin-right:14px;">${esc(s.label)}</a>`)
        .join("")}</p>`
    : "";
  const lines = [f.legalName, f.address, f.disclaimer].filter(Boolean) as string[];
  const legal = lines
    .map((line) => `<p class="dm-muted" style="margin:0 0 4px;font-family:${attr(font.bodyStack)};font-size:${small}px;line-height:1.5;color:${color.muted};">${esc(line)}</p>`)
    .join("");

  return `<tr><td style="padding:14px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="dm-rule" style="border-top:1px solid ${color.border};padding:18px 0 0;">
        ${social}${legal}
        <p class="dm-muted" style="margin:8px 0 0;font-family:${attr(font.bodyStack)};font-size:${small}px;line-height:1.5;color:${color.muted};">
          Not useful? Reply "remove me", or <a href="${attr(optOutUrl)}" style="color:${color.muted};text-decoration:underline;">unsubscribe</a>.
        </p>
      </td>
    </tr></table>
  </td></tr>`;
}

// ── colour helpers ────────────────────────────────────────────────────────────

function gradientCss(color: ResolvedKit["color"]): string {
  if (color.gradient.length < 2) return "";
  // Clients that cannot read the gradient keep the solid accent set just before it.
  return `background-image:linear-gradient(90deg,${color.gradient.join(",")});`;
}

/** A translucent wash of the accent, flattened against the surface for old clients. */
function tint(accent: string, onDark = false): string {
  const [r, g, b] = rgb(accent);
  const base = onDark ? 22 : 255;
  const alpha = onDark ? 0.16 : 0.08;
  const mix = (channel: number) => Math.round(channel * alpha + base * (1 - alpha));
  return `#${[mix(r), mix(g), mix(b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A usable dark palette from the light one, so a brand that never supplied dark values
 * still renders correctly for the large share of readers who use it.
 */
function darkFrom(color: ResolvedKit["color"]) {
  return {
    bg: "#0E0F12",
    surface: "#16181D",
    text: "#EDEEF1",
    muted: "#9AA1AC",
    border: "#282C33",
    accent: lighten(color.accent, 0.22),
    accentText: readableOn(lighten(color.accent, 0.22), color.accentText),
    gradient: color.gradient,
  };
}

/** Keeps the supplied colour when it is legible on the accent, and flips it when it is not. */
function readableOn(background: string, preferred: string): string {
  return contrast(background, preferred) >= 4.5
    ? preferred
    : contrast(background, "#ffffff") >= contrast(background, "#101114")
      ? "#ffffff"
      : "#101114";
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function luminance(hex: string): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = rgb(hex);
  const up = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return `#${[up(r), up(g), up(b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function rgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").slice(0, 6).padEnd(6, "0");
  return [0, 2, 4].map((at) => parseInt(clean.slice(at, at + 2), 16) || 0) as [number, number, number];
}

// ── text ──────────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Attribute values are escaped the same way, so a quote in a URL cannot break out of one. */
function attr(value: string): string {
  return esc(String(value));
}

/**
 * The small subset of markdown composed copy actually uses. Everything is escaped before
 * any markup is added, so nothing a model writes can emit a tag.
 */
function inline(text: string): string {
  let out = esc(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, href: string) => {
    return `<a href="${href.replace(/"/g, "&quot;")}" style="text-decoration:underline;">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])_([^_]+)_/g, "$1<em>$2</em>");
  out = out.replace(/\n/g, "<br />");
  return out;
}
