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
  const rows = block.rows
    .map(
      (r) => `<tr>
        <td class="dm-muted" style="padding:0 0 4px;font-family:${attr(font.bodyStack)};font-size:${small}px;line-height:1.4;color:${color.muted};">${inline(r.label)}</td>
      </tr>
      <tr>
        <td class="dm-ink" style="padding:0 0 14px;font-family:${attr(font.bodyStack)};font-size:${size}px;line-height:1.45;color:${color.text};font-weight:600;">${inline(r.value)}</td>
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
          Not useful? <a href="${attr(optOutUrl)}" style="color:${color.muted};text-decoration:underline;">Unsubscribe</a>.
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
