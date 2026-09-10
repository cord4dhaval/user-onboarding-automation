// Click the i-th navigation item. Reads window.__grabClick = { sel, i }. Returns its label or null.
(() => {
  const { sel, i } = window.__grabClick;
  const el = document.querySelectorAll(sel)[i];
  if (!el) return null;
  const text = (el.textContent || "").trim().slice(0, 40);
  if (/log ?out|sign ?out|delete|remove|upgrade|billing|pay/i.test(text)) return null;
  el.click();
  return text;
})()
