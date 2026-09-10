// Runs in the page before every capture. Reads window.__grab = { map, fakes, company, hints }
// and returns the name map it used, so the next screen reuses the same invented names.
(() => {
  const { map, fakes, company, hints } = window.__grab;
  const FAKE_LOCAL = ["aarav", "diya", "kabir", "ishita", "rohan", "meera", "vihaan", "anaya", "arjun", "sara"];
  const used = new Set(Object.values(map));
  let cursor = 0;
  const nextFake = () => {
    while (cursor < fakes.length && used.has(fakes[cursor])) cursor += 1;
    const f = fakes[cursor] || "Person " + (Object.keys(map).length + 1);
    used.add(f);
    cursor += 1;
    return f;
  };
  // Names arrive with non-breaking spaces and doubled whitespace; one key per person.
  const norm = (t) => t.replace(/[\s\u00a0]+/g, " ").trim();
  const fakeSet = new Set(fakes);
  const fakeFor = (real) => {
    const key = norm(real);
    // An invented name seen on a later screen is not a new person; mapping it again would
    // give one person two names and make the leak check count our own inventions.
    if (fakeSet.has(key) || used.has(key)) return key;
    if (!map[key]) map[key] = nextFake();
    return map[key];
  };
  const UI_WORDS = /^(Home|Dashboard|Reports?|Settings|Team|Teams|Projects?|Members?|Overview|Today|Yesterday|Week|Month|Engineering|Sales|Ops|Design|Marketing|Support|Finance|Admin|Active|Inactive|Idle|Online|Offline|Total|Average|Focus|Meetings?|Attendance|Leave|Goals?|Tasks?|Email|Apps?|Productivity|Summary|Summaries|Patterns?|Search|Filter|Export|Download|Install|Invite|Upgrade|Billing|Profile|Logout|Sign Out|Help|Notifications?|Alerts?|Founder's Report|Ask TeamGrid|TeamGrid|Arclight|Pattern AI|Org Intelligence|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|People|Person|Members|Users|Activity|Story|Hours|Gmail|Slack|Outlook|Classic|Brain|Custom|Live|Silent|Tracked|Create|Export|Import|Live|Stories|Work|Picture|Analytics|Platform|Intelligence|Employee|Workforce|Idle|Time|Requests|Structure|Tracker|Google|Microsoft|Chrome|Figma|Notion|Jira|GitHub|Zoom|Teams|WhatsApp|Asia|Kolkata|India|Sept|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|AM|PM)$/i;
  const nameLike = (t) =>
    t.length >= 3 && t.length <= 40 && /^[A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+){0,3}$/.test(t) &&
    !UI_WORDS.test(t) && !t.split(" ").some((w) => UI_WORDS.test(w));
  const initialsOf = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const peopleSel = "[class*=avatar i], [class*=user i], [class*=employee i], [class*=member i], [class*=person i], [class*=profile i], [class*=assignee i], [class*=owner i], [class*=author i], [class*=name i], [data-testid*=user i], [data-testid*=member i], [data-testid*=name i], td:first-child, [role=row] > *:first-child";
  for (const el of document.querySelectorAll(peopleSel)) {
    for (const node of [...el.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const t = (node.textContent || "").trim();
      if (nameLike(t)) fakeFor(t);
    }
    const own = (el.textContent || "").trim();
    if (el.children.length === 0 && nameLike(own)) fakeFor(own);
  }
  const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const h of hints) if (h && nameLike(h)) fakeFor(h);

  // Greetings name the signed-in person outside any people-shaped element.
  const greet = /(?:Good (?:morning|afternoon|evening)|Welcome(?: back)?|Hi|Hello|Hey),?\s+([A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+)?)/g;
  const allText = document.body.innerText || "";
  for (const m of allText.matchAll(greet)) if (nameLike(m[1])) fakeFor(m[1]);

  // A round circle holding two letters is an initials avatar; the label beside it is the
  // name, whatever its case or spelling. "JD" next to "jenis d..." or "DC" next to
  // "Dhaval Cord4". The circle then gets the invented person's initials.
  for (const circle of document.querySelectorAll("*")) {
    if (circle.children.length > 1) continue;
    const t = (circle.textContent || "").trim();
    if (!/^[A-Z]{1,3}$/.test(t)) continue;
    const cs = getComputedStyle(circle);
    if (!(parseFloat(cs.borderRadius) >= Math.min(circle.clientWidth, circle.clientHeight) * 0.4 && circle.clientWidth <= 96 && circle.clientWidth >= 16)) continue;
    const box = circle.parentElement;
    if (!box) continue;
    const leaves = [...box.querySelectorAll("*")].filter((c) => c !== circle && !circle.contains(c) && c.children.length === 0);
    const label = leaves.map((c) => (c.textContent || "").trim()).find((x) => x.length >= 2 && x.length <= 40 && x[0].toUpperCase() === t[0] && !/^\d/.test(x) && !UI_WORDS.test(x));
    if (!label) continue;
    const fake = fakeFor(label);
    circle.textContent = initialsOf(fake);
  }

  // Text sitting next to a round avatar or an initials circle is a name.
  for (const av of document.querySelectorAll("img, [class*=avatar i], [class*=initial i]")) {
    const cs = getComputedStyle(av);
    const round = parseFloat(cs.borderRadius) >= Math.min(av.clientWidth, av.clientHeight) * 0.4 && av.clientWidth <= 96 && av.clientWidth >= 16;
    if (!round) continue;
    const box = av.parentElement;
    if (!box) continue;
    for (const el of [box, box.parentElement]) {
      if (!el) continue;
      for (const child of el.querySelectorAll("*")) {
        if (child.children.length) continue;
        const t = (child.textContent || "").trim();
        if (nameLike(t)) fakeFor(t);
      }
    }
  }

  // First text cell of any row-like thing: tables, lists, cards in a list.
  for (const row of document.querySelectorAll("tr, li, [role=row]")) {
    const leaf = [...row.querySelectorAll("*")].find((c) => c.children.length === 0 && (c.textContent || "").trim().length >= 3);
    const t = leaf ? norm(leaf.textContent || "") : "";
    // Lead and member lists carry hand-typed names: "Manali gandhi", "Aarav salve". Two
    // words, first one capitalised, no digits, and neither word a piece of UI.
    if (/^[A-Z][a-zA-Z'.-]+ [a-zA-Z'.-]{2,}$/.test(t) && t.length <= 32 && !t.split(" ").some((w) => UI_WORDS.test(w))) fakeFor(t);
  }

  // A truncated label ("jenis…", "Aara…") hides the rest of the name. Take the full name
  // from the element's title attribute when there is one, otherwise find it in the page
  // text by prefix, and map both spellings to the same invented person.
  for (const real of Object.keys(map)) {
    const m = /^(.{3,})(?:…|\.\.\.)$/.exec(real);
    if (!m) continue;
    const prefix = m[1].trim();
    const fake = map[real];
    for (const el of document.querySelectorAll("[title], [aria-label]")) {
      const full = (el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
      if (full.toLowerCase().startsWith(prefix.toLowerCase()) && nameLike(full)) map[full] = fake;
    }
    const re = new RegExp("\\b(" + escapeRe(prefix) + "[a-zA-Z'-]*(?:\\s+[A-Z][a-zA-Z'-]+)?)", "gi");
    for (const hit of (document.body.innerText || "").matchAll(re)) {
      const full = hit[1].trim();
      if (full.length > prefix.length && !map[full]) map[full] = fake;
    }
  }
  // Extra whole-word swaps the operator asked for: project or client names, in real=fake pairs.
  const extra = window.__grab.extra || {};

  const reals = Object.keys(map).sort((a, b) => b.length - a.length);
  // First names and surnames on their own, for views that render the two as separate
  // text nodes (the org graph draws "jenish" and "Dholariya" in two tspans).
  const fakeTokens = new Set(fakes.flatMap((f) => f.split(" ")));
  const firsts = new Map();
  const lasts = new Map();
  for (const r of reals) {
    const parts = r.split(" ");
    const fp = (map[r] || "").split(" ");
    const f = parts[0] || "";
    if (f.length >= 4 && /^[A-Z]/.test(f) && !fakeTokens.has(f) && !firsts.has(f)) firsts.set(f, fp[0] || "");
    const l = parts.length > 1 ? parts[parts.length - 1] : "";
    // Surnames alone only when the whole key is Title Case: "Manali gandhi" is a name, but
    // its lowercase tail is too common a word shape to swap everywhere on its own.
    if (l.length >= 3 && /^[A-Z]/.test(l) && !fakeTokens.has(l) && !lasts.has(l) && !UI_WORDS.test(l)) lasts.set(l, fp[fp.length - 1] || "");
  }

  // Match across any whitespace, so "Jenish Dholariya" in prose and "Jenish\u00a0Dholariya" in a list are one person.
  const loose = (r) => escapeRe(r).replace(/ /g, "[\\s\\u00a0]+");
  // Case-insensitive on purpose: a list can hold "jenish dholariya" while prose says "Jenish Dholariya".
  const lowerMap = Object.fromEntries(reals.map((r) => [norm(r).toLowerCase(), map[r]]));
  const lowerFirsts = new Map([...firsts].map(([k, v]) => [k.toLowerCase(), v]));
  const nameRe = reals.length ? new RegExp("\\b(" + reals.map(loose).join("|") + ")\\b", "gi") : null;
  const firstRe = firsts.size ? new RegExp("\\b(" + [...firsts.keys()].map(escapeRe).join("|") + ")\\b", "gi") : null;
  const lowerLasts = new Map([...lasts].map(([k, v]) => [k.toLowerCase(), v]));
  const lastRe = lasts.size ? new RegExp("\\b(" + [...lasts.keys()].map(escapeRe).join("|") + ")\\b", "gi") : null;
  const emailRe = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  const phoneRe = /(?:\+?\d[\d\s().-]{8,}\d)/g;
  // hints[0] is the account's first name; the rest name its company. Only the company
  // ones get a blanket, case-insensitive replacement, and only as whole words: a first
  // name treated that way once turned "Priya" into "P<company>".
  const companyHints = hints.slice(1).filter((h) => h.length > 3);
  const companyRe = companyHints.length ? new RegExp("\\b(?:" + companyHints.map(escapeRe).join("|") + ")\\b", "gi") : null;
  const emails = new Map();
  const extraKeys = Object.keys(extra);
  const extraRe = extraKeys.length ? new RegExp("\\b(" + extraKeys.map(escapeRe).join("|") + ")\\b", "gi") : null;
  const extraLower = Object.fromEntries(extraKeys.map((k) => [k.toLowerCase(), extra[k]]));
  const scrub = (t) => {
    let out = t;
    if (extraRe) out = out.replace(extraRe, (m) => extraLower[m.toLowerCase()] || m);
    if (nameRe) out = out.replace(nameRe, (m) => lowerMap[norm(m).toLowerCase()] || m);
    if (firstRe) out = out.replace(firstRe, (m) => lowerFirsts.get(m.toLowerCase()) || m);
    if (lastRe) out = out.replace(lastRe, (m) => lowerLasts.get(m.toLowerCase()) || m);
    out = out.replace(emailRe, (m) => {
      if (!emails.has(m)) emails.set(m, FAKE_LOCAL[emails.size % FAKE_LOCAL.length] + "@example.com");
      return emails.get(m);
    });
    out = out.replace(phoneRe, (m) => (m.replace(/\D/g, "").length >= 10 ? "+91 98765 43210" : m));
    if (companyRe) out = out.replace(companyRe, company);
    return out;
  };

  // The whole page, text and attributes, once now and again on every DOM change until the
  // capture: a React re-render after the first pass would otherwise put the real names back.
  const scrubAll = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const before = n.textContent || "";
      const after = scrub(before);
      if (after !== before) n.textContent = after;
    }
    for (const el of document.querySelectorAll("[title], [aria-label], [placeholder], [alt]")) {
      for (const a of ["title", "aria-label", "placeholder", "alt"]) {
        const v = el.getAttribute(a);
        if (v) { const w = scrub(v); if (w !== v) el.setAttribute(a, w); }
      }
    }
    for (const i of document.querySelectorAll("input, textarea")) {
      if (i.value && i.type !== "password") i.value = scrub(i.value);
    }
    for (const img of document.querySelectorAll("img, [class*=avatar i], [style*=background-image]")) {
      const cs = getComputedStyle(img);
      const round = parseFloat(cs.borderRadius) >= Math.min(img.clientWidth, img.clientHeight) * 0.4 && img.clientWidth <= 160;
      const labelled = /avatar|profile|photo|face|user/i.test(img.className + " " + (img.getAttribute("alt") || "") + " " + (img.getAttribute("src") || ""));
      if (round || labelled) img.style.filter = "blur(6px)";
    }
    for (const c of document.querySelectorAll("canvas")) {
      if (c.width >= 200 && c.height >= 200) c.style.filter = "blur(7px)";
    }
    document.title = scrub(document.title);
  };
  const leaksNow = () => {
    const after = document.body.innerText || "";
    return Object.keys(map).filter((r) => r.length >= 4 && !fakeSet.has(r) && !/…|\.\.\.$/.test(r) && new RegExp("\\b" + loose(r) + "\\b", "i").test(after));
  };
  scrubAll();
  window.__grabScrub = () => { scrubAll(); return leaksNow(); };
  if (window.__grabObserver) window.__grabObserver.disconnect();
  // Synchronous on purpose: a mutation callback runs before the next paint, so a live
  // node that rewrites itself every few seconds is scrubbed again before a screenshot can
  // see it. A debounce left a window in which one such label kept its real name.
  let busy = false;
  window.__grabObserver = new MutationObserver((records) => {
    if (busy) return;
    busy = true;
    try {
      window.__grabObserver.disconnect();
      for (const rec of records) {
        const targets = rec.type === "characterData" ? [rec.target.parentElement] : [rec.target, ...rec.addedNodes];
        for (const t of targets) {
          if (!t) continue;
          const root = t.nodeType === Node.TEXT_NODE ? t.parentElement : t;
          if (!root || !root.querySelectorAll) continue;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          for (const n of nodes) {
            const before = n.textContent || "";
            const after = scrub(before);
            if (after !== before) n.textContent = after;
          }
        }
      }
      window.__grabObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    } finally {
      busy = false;
    }
  });
  window.__grabObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { map, leaks: leaksNow() };
})()
