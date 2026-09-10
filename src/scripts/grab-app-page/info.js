// Title, headings and nav labels of the current screen. Runs after anonymize.
(() => ({
  title: document.title,
  h1: [...document.querySelectorAll("h1")].map((h) => (h.textContent || "").trim()).filter(Boolean).slice(0, 5),
  h2: [...document.querySelectorAll("h2")].map((h) => (h.textContent || "").trim()).filter(Boolean).slice(0, 20),
  nav: [...document.querySelectorAll("nav a, aside a, nav button, aside button")].map((a) => (a.textContent || "").trim()).filter(Boolean).slice(0, 40),
}))()
