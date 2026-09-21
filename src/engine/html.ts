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
 * A picture a product keeps for the top of its designed mail, and the words that pick it.
 *
 * Kept in the product's config (`email.illustrations`), in priority order. The first whose
 * words appear in what the touch is about wins; one with no words is the fallback. The
 * pictures carry no numbers, so no mail shows a figure its own story does not.
 */
export interface Illustration {
  key: string;
  url: string;
  alt: string;
  /** The band colour behind the picture, which is all a reader with images off sees. */
  bg: string;
  match?: string[];
}

/** What a designed mail carries of the brand, and the picture on top when there is one. */
export interface DesignedBrand extends LetterBrand {
  hero?: { url: string; alt: string; bg: string };
}

/** Whether a product's designed format is the editorial one rather than the plain card. */
export function editorialDesign(product?: Record<string, unknown> | null): boolean {
  return (product?.config as { email?: { style?: unknown } } | undefined)?.email?.style === "editorial";
}

/** The product's picture for a touch, from its hook, theme, angle or template key. */
export function illustrationFor(product: Record<string, unknown> | null | undefined, about: unknown[]): Illustration | undefined {
  const list = ((product?.config as { email?: { illustrations?: Illustration[] } } | undefined)?.email?.illustrations ?? []).filter(
    (i) => typeof i?.url === "string" && i.url,
  );
  if (!list.length) return undefined;
  const hay = about.filter((x): x is string => typeof x === "string").join(" ").toLowerCase();
  return list.find((i) => (i.match ?? []).some((w) => hay.includes(w.toLowerCase()))) ?? list.find((i) => !i.match?.length);
}

/**
 * The brand a designed or picture mail wears. A message that carries its own picture puts it
 * on top in place of the product's illustration: its text was written about that picture.
 */
export function designedBrandFrom(
  kit: ResolvedKit,
  product: Record<string, unknown> | null | undefined,
  about: unknown[],
  picture?: { url: string; alt: string; bg: string },
): DesignedBrand {
  const hero = picture ?? illustrationFor(product, about);
  return { ...letterBrandFrom(kit, product), ...(hero ? { hero: { url: hero.url, alt: hero.alt, bg: hero.bg } } : {}) };
}

/**
 * The HTML for an email in the format it goes out as. One place for the choice, so the
 * sender and the review screen cannot disagree about what a format looks like.
 */
export function emailHtmlFor(
  format: unknown,
  resolved: ResolvedTemplate,
  kit: ResolvedKit,
  product: Record<string, unknown> | null | undefined,
  about: unknown[],
  picture?: { url: string; alt: string; bg: string },
): string {
  if (String(format) === "letter") return renderLetter(resolved, letterBrandFrom(kit, product));
  if (String(format) === "picture" && picture) return renderPicture(resolved, designedBrandFrom(kit, product, about, picture));
  return editorialDesign(product) ? renderDesigned(resolved, designedBrandFrom(kit, product, about, picture)) : renderHtml(resolved, kit);
}

/**
 * The editorial designed format (Dhaval chose it on 2026-09-21 from the preview pages):
 * the logo and name on top, an illustrated band when the product has a picture for the
 * subject, the opening set as the headline, the product's part in a tinted panel with
 * drawn check chips, example costs in a bordered card, sample figures as large numbers,
 * one button, and the signature at the foot.
 *
 * Everything that carries meaning is text in table cells, so it reads the same in Outlook
 * and with images off; the picture is decoration on a band of its own colour. Always light,
 * for the same reason as the letter: a dark-capable scheme painted previews black.
 */
export function renderDesigned(resolved: ResolvedTemplate, brand: DesignedBrand): string {
  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const T = `role="presentation" cellpadding="0" cellspacing="0" border="0"`;
  const accent = brand.accent || "#1a73e8";
  const ink = inkOf(accent);
  const soft = lighten(accent, 0.9);
  const [text, body, muted, rule] = ["#101114", "#3c4043", "#5f6368", "#e5e7eb"];
  const name = brand.name?.trim() || "";
  const site = brand.website ? brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  const withName = (html: string) =>
    name ? html.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), `<strong style="color:${ink};">${esc(name)}</strong>`) : html;
  const row = (html: string, pb = 24) => `<tr><td style="padding:0 0 ${pb}px;">${html}</td></tr>`;
  const para = (html: string, size = 16, color = body, weight = 400, margin = 0) =>
    `<p style="margin:0 0 ${margin}px;font-family:${F};font-size:${size}px;line-height:1.6;color:${color};font-weight:${weight};">${html}</p>`;
  const paras = (raw: string, size = 16, color = body, gap = 14, marked = false) => {
    const parts = raw.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
    return parts.map((p, k) => para(marked ? withName(inline(p)) : inline(p), size, color, 400, k === parts.length - 1 ? 0 : gap)).join("");
  };
  const label = (t: string) =>
    `<p style="margin:0 0 10px;font-family:${F};font-size:11px;line-height:1.4;letter-spacing:0.08em;font-weight:700;text-transform:uppercase;color:${muted};">${inline(t.replace(/:\s*$/, ""))}</p>`;
  const hair = `<table ${T} width="100%"><tr><td style="border-top:1px solid ${rule};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const logo = (size: number) =>
    brand.logoUrl ? `<img src="${attr(brand.logoUrl)}" width="${size}" height="${size}" alt="${attr(name)}" style="display:block;border:0;border-radius:6px;" />` : "";
  const chip = (glyph: string, size = 28) =>
    `<table ${T}><tr><td width="${size}" height="${size}" align="center" valign="middle" bgcolor="${soft}" style="width:${size}px;height:${size}px;background:${soft};border-radius:8px;font-family:${F};font-size:14px;font-weight:700;color:${ink};">${glyph}</td></tr></table>`;
  const checks = (items: string[]) =>
    `<table ${T} width="100%">${items
      .map((item, k) => `<tr><td width="40" valign="top" style="padding:0 0 ${k === items.length - 1 ? 0 : 10}px;">${chip("&#10003;")}</td><td valign="middle" style="padding:0 0 ${k === items.length - 1 ? 0 : 10}px;font-family:${F};font-size:15px;line-height:1.5;color:${text};">${inline(item)}</td></tr>`)
      .join("")}</table>`;
  // Two or three sample figures ("6h 40m tracked", "4.2h deep focus") read as numbers, not
  // as lines of a receipt; anything richer keeps the sample card.
  const figures = (items: string[]) => {
    const parsed = items.map((i) => /^((?:₹\s?)?[\d.,]+\s?(?:h|m|%|hrs?|min)?(?:\s\d+m)?)\s+([^·:]{2,40})$/i.exec(i.trim()));
    if (items.length < 2 || items.length > 3 || parsed.some((m) => !m)) return "";
    return `<table ${T} width="100%"><tr>${parsed
      .map((m, k) => `<td class="col" width="${Math.floor(100 / parsed.length)}%" valign="top" style="padding:0 0 0 ${k ? 16 : 0}px;${k ? `border-left:1px solid ${rule};` : ""}"><div style="font-family:${F};font-size:26px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:${k ? text : ink};white-space:nowrap;">${esc(m![1]!)}</div><div style="font-family:${F};font-size:12px;line-height:1.4;color:${muted};padding-top:4px;">${inline(m![2]!)}</div></td>`)
      .join("")}</tr></table>`;
  };
  const sample = (title: string, items: string[]) => {
    const big = figures(items);
    return big ? `${title ? label(title) : ""}${big}` : sampleCard(title, items, ink);
  };
  // What follows a heading line in the frame: a list of what the product shows, or a sample.
  const partsAfter = (title: string, list: Extract<ResolvedBlock, { kind: "list" }>) =>
    list.style === "receipt" ? sample(title, list.items) : `${label(title)}${list.style === "check" ? checks(list.items) : bullets(list)}`;
  const bullets = (list: Extract<ResolvedBlock, { kind: "list" }>) =>
    `<ul style="margin:0;padding:0 0 0 22px;">${list.items
      .map((item) => `<li style="margin:0 0 6px;font-family:${F};font-size:16px;line-height:1.6;color:${body};">${list.style === "strike" ? `<s>${inline(item)}</s>` : inline(item)}</li>`)
      .join("")}</ul>`;
  const panel = (inner: string) =>
    `<table ${T} width="100%"><tr><td bgcolor="${soft}" style="background:${soft};border-radius:12px;padding:20px 22px;">${inner}</td></tr></table>`;

  const blocks = resolved.blocks;
  const rows: string[] = [];
  let ctaSeen = false;
  let signed = false;
  // A template with no written opening (the welcome) still gets a headline: its first short
  // line after the greeting.
  const headlineAt = blocks.some((b) => b.kind === "text" && b.slot === "opening")
    ? -1
    : blocks.findIndex((b) => b.kind === "text" && !b.slot && !/^(hi|hello|dear)\b/i.test(b.text.trim()) && b.text.trim().length <= 70 && !b.text.includes("\n"));
  const signature = () => {
    if (signed || !name) return "";
    signed = true;
    return `${hair}<table ${T} style="margin-top:20px;"><tr>${brand.logoUrl ? `<td valign="top" style="padding:2px 12px 0 0;">${logo(32)}</td>` : ""}<td valign="top" style="font-family:${F};font-size:12px;line-height:1.55;color:${muted};"><strong style="color:${text};font-size:13px;">${esc(name)}</strong>${
      brand.tagline ? `<br />${esc(brand.tagline)}` : ""
    }${brand.website ? `<br /><a href="${attr(brand.website)}" style="color:${ink};font-weight:700;text-decoration:none;">${esc(site)}</a>` : ""}</td></tr></table>`;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    switch (block.kind) {
      case "preheader":
        break;
      case "heading":
        rows.push(row(`<h2 style="margin:0;font-family:${F};font-size:22px;line-height:1.25;letter-spacing:-0.01em;font-weight:700;color:${text};">${inline(block.text)}</h2>`, 16));
        break;
      case "text": {
        const raw = block.text.trim();
        if (block.slot === "opening" || i === headlineAt) {
          rows.push(row(`<h1 class="h1" style="margin:0;font-family:${F};font-size:26px;line-height:1.25;letter-spacing:-0.02em;font-weight:700;color:${text};">${inline(raw.replace(/\*\*/g, ""))}</h1>`, 18));
          break;
        }
        if (block.slot === "question") {
          rows.push(row(para(inline(raw.replace(/\*\*/g, "")), 18, text, 700), 24));
          break;
        }
        if (block.slot === "limit") {
          rows.push(row(`<table ${T}><tr><td valign="top" style="padding:0 8px 0 0;font-family:${F};font-size:14px;font-weight:700;color:${ink};">&#10003;</td><td style="font-family:${F};font-size:14px;line-height:1.5;color:${muted};">${inline(raw)}</td></tr></table>`, 24));
          break;
        }
        if (block.slot === "timeline") {
          const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
          rows.push(
            row(
              `<table ${T} width="100%">${lines
                .map((l, k) => {
                  const m = /^\*\*(.+?):?\*\*:?\s*(.*)$/.exec(l);
                  return `<tr><td width="22" valign="top" style="padding:5px 0 0;"><table ${T}><tr><td width="10" height="10" bgcolor="${k === lines.length - 1 ? ink : lighten(accent, 0.55)}" style="width:10px;height:10px;border-radius:5px;background:${k === lines.length - 1 ? ink : lighten(accent, 0.55)};font-size:0;line-height:0;">&nbsp;</td></tr></table></td><td valign="top" style="padding:0 0 ${k === lines.length - 1 ? 0 : 12}px;"><div style="font-family:${F};font-size:11px;letter-spacing:0.08em;font-weight:700;text-transform:uppercase;color:${ink};">${inline(m ? m[1]! : "")}</div><div style="font-family:${F};font-size:15px;line-height:1.5;color:${text};padding-top:2px;">${inline(m ? m[2]! : l)}</div></td></tr>`;
                })
                .join("")}</table>`,
              24,
            ),
          );
          break;
        }
        if (block.slot === "reveal") {
          // The product's part: its words, and the list or sample that shows it, in one panel.
          let inner = `<table ${T} style="margin:0 0 12px;"><tr>${brand.logoUrl ? `<td valign="middle" style="padding:0 8px 0 0;">${logo(20)}</td>` : ""}<td valign="middle" style="font-family:${F};font-size:11px;letter-spacing:0.08em;font-weight:700;text-transform:uppercase;color:${ink};">${esc(name ? `What ${name} shows` : "What you would see")}</td></tr></table>${paras(raw, 16, text, 12, true)}`;
          const title = blocks[i + 1];
          const list = blocks[i + 2];
          if (title?.kind === "text" && title.tight && list?.kind === "list" && list.fromParts) {
            inner += `<table ${T} width="100%" style="margin-top:18px;"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:10px;padding:16px 18px;">${partsAfter(title.text.replace(new RegExp(`^What ${name} would show you:?$`, "i"), "What you would see"), list)}</td></tr></table>`;
            i += 2;
          }
          rows.push(row(panel(inner), 16));
          break;
        }
        if (block.tight && next?.kind === "list" && next.fromParts) {
          rows.push(row(partsAfter(raw, next), 24));
          i++;
          break;
        }
        if (/^(hi|hello|dear)\b[^\n]{0,40},$/i.test(raw)) {
          rows.push(row(para(inline(raw), 16, body), 14));
          break;
        }
        if (/^P\.S\./.test(raw)) {
          rows.push(row(para(inline(raw), 14, muted), 24));
          break;
        }
        if (/^best regards,?/i.test(raw) || raw === `The ${name} Team`) {
          rows.push(row(para(inline(raw), 16, body), next?.kind === "text" && next.text.trim() === `The ${name} Team` ? 0 : 24));
          break;
        }
        rows.push(row(paras(raw), block.tight ? 8 : 20));
        break;
      }
      case "list":
        rows.push(row(block.style === "receipt" ? sample("", block.items) : block.style === "check" ? checks(block.items) : bullets(block), 24));
        break;
      case "card": {
        const inner = block.rows
          .map(
            (r, k) =>
              `<tr><td style="padding:${k ? 12 : 0}px 0 0;${k ? `border-top:1px solid ${rule};` : ""}"><div style="font-family:${F};font-size:15px;line-height:1.5;color:${text};">${inline(r.label)}</div>${
                r.value ? `<div style="font-family:${F};font-size:16px;line-height:1.5;font-weight:700;color:${ink};padding:2px 0 ${k === block.rows.length - 1 ? 0 : 12}px;">&rarr; ${inline(r.value.replace(/^\s*(→|->|&rarr;)\s*/, ""))}</div>` : ""
              }</td></tr>`,
          )
          .join("");
        rows.push(
          row(
            `<table ${T} width="100%" style="border:1px solid ${rule};border-radius:12px;border-collapse:separate;"><tr><td style="padding:18px 20px;">${block.title ? label(block.title) : ""}<table ${T} width="100%">${inner}</table></td></tr></table>`,
            24,
          ),
        );
        break;
      }
      case "callout":
        rows.push(row(panel(para(inline(block.text), 15, text)), 24));
        break;
      case "divider":
        rows.push(row(hair, 24));
        break;
      case "image": {
        // The message's own picture already sits on top as the hero.
        if (brand.hero && block.url === brand.hero.url) break;
        const img = `<img src="${attr(block.url)}" alt="${attr(block.alt)}" width="${Math.min(block.width ?? 512, 512)}" style="display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:10px;" />`;
        rows.push(row(block.href ? `<a href="${attr(block.href)}" style="text-decoration:none;">${img}</a>` : img, 24));
        break;
      }
      case "cta":
        if (ctaSeen) {
          rows.push(row(para(`<a href="${attr(block.url)}" style="color:${ink};font-weight:700;">${inline(block.text)}</a>`), 24));
        } else {
          rows.push(
            row(
              `<table ${T}><tr><td bgcolor="${ink}" style="background:${ink};border-radius:8px;"><a class="cta" href="${attr(block.url)}" style="display:inline-block;padding:14px 24px;font-family:${F};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${inline(block.text)} &rarr;</a></td></tr></table>`,
              28,
            ),
          );
          ctaSeen = true;
        }
        break;
      case "optout":
        rows.push(
          row(
            `${signature()}<p style="margin:18px 0 0;font-family:${F};font-size:12px;line-height:1.5;color:${muted};">Not useful? Reply "remove me", or <a href="${attr(block.url)}" style="color:${muted};">unsubscribe</a>.</p>`,
            0,
          ),
        );
        break;
    }
  }
  if (!signed && name) rows.push(row(signature(), 0));

  const header = `<table ${T} width="100%"><tr><td valign="middle"><table ${T}><tr>${brand.logoUrl ? `<td style="padding:0 8px 0 0;">${logo(28)}</td>` : ""}<td style="font-family:${F};font-size:16px;font-weight:700;color:${text};">${esc(name)}</td></tr></table></td>${
    site ? `<td align="right" valign="middle" style="font-family:${F};font-size:12px;color:${muted};">${esc(site)}</td>` : ""
  }</tr></table>`;
  const hero = brand.hero
    ? `<tr><td bgcolor="${attr(brand.hero.bg)}" align="center" style="background:${attr(brand.hero.bg)};"><img src="${attr(brand.hero.url)}" width="600" height="260" alt="${attr(brand.hero.alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;font-family:${F};font-size:15px;font-weight:700;line-height:1.5;color:${ink};" /></td></tr>`
    : "";
  const preheader = blocks.find((b) => b.kind === "preheader");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(resolved.subject ?? "")}</title>
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;border-radius:0 !important;}
    .outer{padding:0 !important;}
    .pad{padding-left:22px !important;padding-right:22px !important;}
    .h1{font-size:23px !important;}
    .col{display:block !important;width:100% !important;border-left:0 !important;padding:0 0 14px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
${preheaderHtml(preheader)}
<table ${T} width="100%" style="background:#f4f5f7;"><tr><td class="outer" align="center" style="padding:32px 12px;">
  <table ${T} class="wrap" width="600" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td class="pad" style="padding:${hero ? "22px 44px 18px" : "36px 44px 28px"};">${header}</td></tr>
    ${hero}
    <tr><td class="pad" style="padding:${hero ? 30 : 4}px 44px 36px;"><table ${T} width="100%">${rows.join("\n")}</table></td></tr>
  </table>
</td></tr></table>
</body>
</html>`;
}

/**
 * Template 4, "picture + short text" (Dhaval chose it on 2026-09-21).
 *
 * The picture carries the findings: the hours, the sites, the late start, the quiet deal. The
 * words add only what the picture cannot show: what it costs, what the product does about
 * it, what the reader gets back, and one button. The first drafts repeated the picture's
 * numbers in a table under it, which he called "basically repetition of data".
 *
 * It reads the same frame and parts as the other formats, so a reviewer can still switch a
 * picture mail to designed, letter or plain text. Here the opening is a bold line, the scene
 * the lead under the picture, the cost card a two-column table, the shows list a set of
 * ticks, the question the highlighted "what you get back" line and the limit a small note.
 * With images off the band keeps its colour and the alt text says what the picture showed.
 */
export function renderPicture(resolved: ResolvedTemplate, brand: DesignedBrand): string {
  const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const T = `role="presentation" cellpadding="0" cellspacing="0" border="0"`;
  const accent = brand.accent || "#1a73e8";
  const ink = inkOf(accent);
  const soft = lighten(accent, 0.9);
  const [text, body, muted, rule] = ["#101114", "#3c4043", "#5f6368", "#e5e7eb"];
  const name = brand.name?.trim() || "";
  const site = brand.website ? brand.website.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  const row = (html: string, pb = 20) => `<tr><td style="padding:0 0 ${pb}px;">${html}</td></tr>`;
  const para = (html: string, size = 16, color = body, weight = 400) =>
    `<p style="margin:0;font-family:${F};font-size:${size}px;line-height:1.6;color:${color};font-weight:${weight};">${html}</p>`;
  const paras = (raw: string) => raw.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).map((p, k, all) => `${para(inline(p))}${k < all.length - 1 ? '<div style="height:12px;line-height:12px;font-size:0;">&nbsp;</div>' : ""}`).join("");
  const label = (t: string) =>
    `<p style="margin:0 0 8px;font-family:${F};font-size:11px;line-height:1.4;letter-spacing:0.08em;font-weight:700;text-transform:uppercase;color:${muted};">${inline(t.replace(/:\s*$/, ""))}</p>`;
  const hair = `<table ${T} width="100%"><tr><td style="border-top:1px solid ${rule};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const logo = (size: number) =>
    brand.logoUrl ? `<img src="${attr(brand.logoUrl)}" width="${size}" height="${size}" alt="${attr(name)}" style="display:block;border:0;border-radius:6px;" />` : "";
  const checks = (items: string[]) =>
    `<table ${T} width="100%">${items
      .map(
        (item, k) =>
          `<tr><td width="30" valign="top" style="padding:0 0 ${k === items.length - 1 ? 0 : 8}px;"><table ${T}><tr><td width="20" height="20" align="center" valign="middle" bgcolor="${soft}" style="width:20px;height:20px;background:${soft};border-radius:6px;font-family:${F};font-size:12px;font-weight:700;color:${ink};">&#10003;</td></tr></table></td><td valign="top" style="padding:0 0 ${k === items.length - 1 ? 0 : 8}px;font-family:${F};font-size:15px;line-height:1.45;color:${text};">${inline(item)}</td></tr>`,
      )
      .join("")}</table>`;
  const bullets = (items: string[]) =>
    `<ul style="margin:0;padding:0 0 0 22px;">${items.map((item) => `<li style="margin:0 0 6px;font-family:${F};font-size:15px;line-height:1.5;color:${body};">${inline(item)}</li>`).join("")}</ul>`;
  // What it costs: the situation on the left, the amount on the right, one hairline apart.
  const costTable = (rows: Array<{ label: string; value: string }>) =>
    `<table ${T} width="100%">${rows
      .map(
        (r, k) =>
          `<tr><td valign="top" style="padding:9px 12px 9px 0;${k ? `border-top:1px solid ${rule};` : ""}font-family:${F};font-size:15px;line-height:1.45;color:${body};">${inline(r.label)}</td><td valign="top" align="right" style="padding:9px 0;${k ? `border-top:1px solid ${rule};` : ""}font-family:${F};font-size:15px;line-height:1.45;font-weight:700;color:${text};">${inline(r.value.replace(/^\s*(→|->|&rarr;)\s*/, ""))}</td></tr>`,
      )
      .join("")}</table>`;

  const blocks = resolved.blocks;
  const rows: string[] = [];
  let ctaSeen = false;
  let signed = false;
  const signature = () => {
    if (signed || !name) return "";
    signed = true;
    return `${hair}<table ${T} style="margin-top:18px;"><tr>${brand.logoUrl ? `<td valign="top" style="padding:2px 12px 0 0;">${logo(30)}</td>` : ""}<td valign="top" style="font-family:${F};font-size:12px;line-height:1.55;color:${muted};"><strong style="color:${text};font-size:13px;">${esc(name)}</strong>${
      brand.tagline ? `<br />${esc(brand.tagline)}` : ""
    }${brand.website ? `<br /><a href="${attr(brand.website)}" style="color:${ink};font-weight:700;text-decoration:none;">${esc(site)}</a>` : ""}</td></tr></table>`;
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    switch (block.kind) {
      case "preheader":
        break;
      case "heading":
        rows.push(row(para(inline(block.text), 20, text, 700), 14));
        break;
      case "text": {
        const raw = block.text.trim();
        if (block.slot === "opening") {
          rows.push(row(para(inline(raw.replace(/\*\*/g, "")), 18, text, 700), 12));
          break;
        }
        if (block.slot === "question") {
          rows.push(
            row(
              `<table ${T} width="100%"><tr><td bgcolor="${soft}" style="background:${soft};border-left:3px solid ${ink};border-radius:0 8px 8px 0;padding:12px 16px;font-family:${F};font-size:15px;line-height:1.5;font-weight:700;color:${ink};">${inline(raw.replace(/\*\*/g, ""))}</td></tr></table>`,
              24,
            ),
          );
          break;
        }
        if (block.slot === "limit") {
          rows.push(row(para(inline(raw), 13, muted), 18));
          break;
        }
        if (block.tight && next?.kind === "list" && next.fromParts) {
          rows.push(row(`${label(raw)}${next.style === "receipt" ? sampleCard("", next.items, ink) : checks(next.items)}`, 22));
          i++;
          break;
        }
        if (/^(hi|hello|dear)\b[^\n]{0,40},$/i.test(raw)) {
          rows.push(row(para(inline(raw)), 12));
          break;
        }
        if (/^P\.S\./.test(raw)) {
          rows.push(row(para(inline(raw), 14, muted), 20));
          break;
        }
        if (/^best regards,?/i.test(raw)) {
          rows.push(row(para(inline(raw)), 20));
          break;
        }
        rows.push(row(paras(raw), block.tight ? 8 : 20));
        break;
      }
      case "list":
        rows.push(row(block.style === "receipt" ? sampleCard("", block.items, ink) : block.style === "check" ? checks(block.items) : bullets(block.items), 22));
        break;
      case "card":
        rows.push(row(`${block.title ? label(block.title) : ""}${costTable(block.rows)}`, 22));
        break;
      case "callout":
        rows.push(row(para(inline(block.text), 15, text), 20));
        break;
      case "divider":
        rows.push(row(hair, 20));
        break;
      case "image": {
        // The picture is on top already; any other image sits where the frame put it.
        if (brand.hero && block.url === brand.hero.url) break;
        const img = `<img src="${attr(block.url)}" alt="${attr(block.alt)}" width="512" style="display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:10px;" />`;
        rows.push(row(block.href ? `<a href="${attr(block.href)}" style="text-decoration:none;">${img}</a>` : img, 20));
        break;
      }
      case "cta":
        if (ctaSeen) {
          rows.push(row(para(`<a href="${attr(block.url)}" style="color:${ink};font-weight:700;">${inline(block.text)}</a>`), 20));
        } else {
          rows.push(
            row(
              `<table ${T}><tr><td bgcolor="${ink}" style="background:${ink};border-radius:8px;"><a class="cta" href="${attr(block.url)}" style="display:inline-block;padding:13px 22px;font-family:${F};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${inline(block.text)} &rarr;</a></td></tr></table>`,
              24,
            ),
          );
          ctaSeen = true;
        }
        break;
      case "optout":
        rows.push(
          row(
            `${signature()}<p style="margin:18px 0 0;font-family:${F};font-size:12px;line-height:1.5;color:${muted};">Not useful? Reply "remove me", or <a href="${attr(block.url)}" style="color:${muted};">unsubscribe</a>.</p>`,
            0,
          ),
        );
        break;
    }
  }
  if (!signed && name) rows.push(row(signature(), 0));

  const header = `<table ${T} width="100%"><tr><td valign="middle"><table ${T}><tr>${brand.logoUrl ? `<td style="padding:0 8px 0 0;">${logo(26)}</td>` : ""}<td style="font-family:${F};font-size:16px;font-weight:700;color:${text};">${esc(name)}</td></tr></table></td>${
    site ? `<td align="right" valign="middle" style="font-family:${F};font-size:12px;color:${muted};">${esc(site)}</td>` : ""
  }</tr></table>`;
  const hero = brand.hero
    ? `<tr><td bgcolor="${attr(brand.hero.bg)}" align="center" style="background:${attr(brand.hero.bg)};"><img src="${attr(brand.hero.url)}" width="600" height="260" alt="${attr(brand.hero.alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;font-family:${F};font-size:15px;font-weight:700;line-height:1.5;color:${ink};" /></td></tr>`
    : "";
  const preheader = blocks.find((b) => b.kind === "preheader");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(resolved.subject ?? "")}</title>
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;border-radius:0 !important;}
    .outer{padding:0 !important;}
    .pad{padding-left:22px !important;padding-right:22px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
${preheaderHtml(preheader)}
<table ${T} width="100%" style="background:#f4f5f7;"><tr><td class="outer" align="center" style="padding:32px 12px;">
  <table ${T} class="wrap" width="600" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td class="pad" style="padding:20px 40px 16px;">${header}</td></tr>
    ${hero}
    <tr><td class="pad" style="padding:${hero ? 28 : 4}px 40px 34px;"><table ${T} width="100%">${rows.join("\n")}</table></td></tr>
  </table>
</td></tr></table>
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
export function sampleCard(title: string, lines: string[], ink: string): string {
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
