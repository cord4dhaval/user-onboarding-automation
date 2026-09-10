// Scroll the page and its inner scroll container once so lazy sections mount, then return
// the height the viewport must grow to for everything to be in-flow. App shells usually
// scroll inside <main>, not the document, so the document's own scrollHeight lies.
(async () => {
  const scrollers = [...document.querySelectorAll("*")].filter((el) => {
    const cs = getComputedStyle(el);
    return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40 && el.clientWidth > 400;
  });
  const main = scrollers.sort((a, b) => b.clientWidth * b.scrollHeight - a.clientWidth * a.scrollHeight)[0] || null;
  const walk = async (el, max, set) => {
    const step = Math.max(400, window.innerHeight - 100);
    for (let y = 0; y < max; y += step) {
      set(y);
      await new Promise((r) => setTimeout(r, 150));
    }
    set(0);
  };
  await walk(null, document.documentElement.scrollHeight, (y) => window.scrollTo(0, y));
  if (main) await walk(main, main.scrollHeight, (y) => { main.scrollTop = y; });
  await new Promise((r) => setTimeout(r, 500));
  let h = document.documentElement.scrollHeight;
  if (main) h = Math.max(h, Math.round(main.getBoundingClientRect().top + window.scrollY + main.scrollHeight + 40));
  return h;
})()
