// Same-origin hrefs on the page.
(() => [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.href, text: (a.textContent || "").trim().slice(0, 40) })))()
