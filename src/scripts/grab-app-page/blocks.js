// The big rectangles on the page: cards, charts, tables. Page coordinates, CSS px.
(() => {
  const out = [];
  const seen = [];
  const candidates = document.querySelectorAll("main section, main article, main [class*=card i], main [class*=panel i], main [class*=chart i], main [class*=widget i], main table, [role=region], [data-testid]");
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const abs = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
    if (abs.w < 320 || abs.h < 160 || abs.w * abs.h > 1440 * 2200) continue;
    if (seen.some((s) => Math.abs(s.x - abs.x) < 8 && Math.abs(s.y - abs.y) < 8 && Math.abs(s.w - abs.w) < 8)) continue;
    seen.push(abs);
    const heading = el.querySelector("h1,h2,h3,h4,[class*=title i]");
    out.push({ ...abs, label: heading ? (heading.textContent || "").trim().slice(0, 60) : "" });
    if (out.length >= 14) break;
  }
  return out;
})()
