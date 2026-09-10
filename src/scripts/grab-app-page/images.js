// Every non-avatar image on the page, fetched with the page's own cookies, as base64.
(async () => {
  const seen = new Set();
  const out = [];
  const want = [];
  for (const img of document.querySelectorAll("img")) {
    const cs = getComputedStyle(img);
    const round = parseFloat(cs.borderRadius) >= Math.min(img.clientWidth, img.clientHeight) * 0.4 && img.clientWidth <= 160;
    const avatar = round || /avatar|profile|photo|face|user|gravatar|googleusercontent/i.test(img.className + " " + img.alt + " " + img.currentSrc);
    if (avatar || !img.currentSrc || img.naturalWidth < 24) continue;
    want.push({ src: img.currentSrc, alt: img.alt, w: img.naturalWidth, h: img.naturalHeight });
  }
  for (const el of document.querySelectorAll("*")) {
    const m = /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage);
    if (m && !m[1].startsWith("data:")) want.push({ src: m[1], alt: "", w: 0, h: 0 });
  }
  for (const im of want) {
    if (seen.has(im.src) || im.src.startsWith("data:") || im.src.startsWith("blob:")) continue;
    seen.add(im.src);
    try {
      const r = await fetch(im.src, { credentials: "include" });
      if (!r.ok) continue;
      const b = await r.blob();
      if (!/^image\//.test(b.type)) continue;
      const buf = new Uint8Array(await b.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
      out.push({ ...im, mime: b.type, b64: btoa(bin) });
    } catch (e) { /* one image is not worth stopping for */ }
    if (out.length >= 40) break;
  }
  return out;
})()
