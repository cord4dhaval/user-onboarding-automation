// Builds the TeamGrid email illustrations as HTML (600x260) and renders each to a 1200x520 PNG.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const CHROME = `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell/mac_arm-148.0.7778.97/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const MARK = readFileSync("/Users/amitg/Dhaval_react/temgrid-onboarding/assets/teamgrid/logos/mark-teamgrid.svg", "utf8");

const I = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  cam: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.2"/><path d="M3 3l18 18"/>',
  keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10.5 10h.01M14.5 10h.01M17.5 10h.01M7.5 14h9"/><path d="M3 3l18 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  belloff: '<path d="M8.7 3.7A6 6 0 0 1 18 8c0 4 1 6 2 7"/><path d="M6 8c0 7-3 9-3 9h14"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="M3 3l18 18"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  alert: '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4M12 16.8h.01"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2 19h20"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  headph: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="M15.5 10.5l5.5-3v9l-5.5-3"/><path d="M3 3l18 18"/>',
};
const ic = (k, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;
const mark = (cls = "mk") => MARK.replace("<svg ", `<svg class="${cls}" `);
const AV = { P: "#F2673A", R: "#366EB6", M: "#6C59A6", A: "#34A851", K: "#2DBDB8", I: "#e0a100", N: "#64748b", Y: "#0f172a" };
const av = (n) => `<span class="av" style="--c:${AV[n[0]]}">${n[0]}</span>`;
// A hand-drawn arrow: from (x1,y1) curving to (x2,y2).
const doodle = (x1, y1, x2, y2, bend = -30, color = "#F2673A") => {
  const mx = (x1 + x2) / 2 + bend, my = (y1 + y2) / 2 - Math.abs(bend) / 2;
  const a = Math.atan2(y2 - my, x2 - mx), h = 7;
  const p1 = [x2 - h * Math.cos(a - 0.5), y2 - h * Math.sin(a - 0.5)], p2 = [x2 - h * Math.cos(a + 0.5), y2 - h * Math.sin(a + 0.5)];
  return `<svg class="doodle" viewBox="0 0 600 260" width="600" height="260"><path d="M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M${p1} L${x2} ${y2} L${p2}" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
};

const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:600px;height:260px;overflow:hidden}
body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:#0f172a;background:var(--bg);position:relative;-webkit-font-smoothing:antialiased}
.glow{position:absolute;inset:0;background:radial-gradient(420px 260px at 88% 40%,rgba(255,255,255,.85),rgba(255,255,255,0) 70%)}
.dots{position:absolute;inset:0;background-image:radial-gradient(rgba(15,23,42,.08) 1px,transparent 1.2px);background-size:14px 14px;-webkit-mask-image:linear-gradient(90deg,transparent 30%,#000 75%)}
.copy{position:absolute;left:28px;top:34px;width:234px}
.eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#0f5f5b;background:#fff;border:1px solid rgba(45,189,184,.5);border-radius:99px;padding:4px 10px 4px 6px;box-shadow:0 1px 2px rgba(15,23,42,.05)}
.eyebrow .mk{width:12px;height:13px}
h1{font-size:25px;line-height:1.1;font-weight:800;letter-spacing:-.025em;margin-top:13px}
h1 span{display:block;color:#8b95a7}
.sub{font-size:12px;color:#334155;margin-top:11px;line-height:1.42;font-weight:600;text-wrap:balance}
.card{position:absolute;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 1px 2px rgba(15,23,42,.05),0 14px 30px -12px rgba(15,23,42,.22)}
.ic{width:14px;height:14px;flex:none}
.av{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;flex:none;font-size:9.5px;font-weight:800;color:#fff;background:var(--c);box-shadow:0 0 0 2px #fff}
.hd{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#0f172a}
.hd .mk{width:13px;height:14px}
.hd .r{margin-left:auto;font-weight:600;color:#94a3b8;font-size:10px}
.live{display:inline-flex;align-items:center;gap:4px;font-size:8.5px;letter-spacing:.08em;font-weight:800;color:#ef4444}
.live i{width:6px;height:6px;border-radius:50%;background:#ef4444}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;font-weight:700;border-radius:99px;padding:3px 8px}
.ok{color:#15803d;background:#dcfce7}.warn{color:#b45309;background:#fef3c7}.teal{color:#0f5f5b;background:#d5f3f1}.grey{color:#64748b;background:#f1f5f9}
.hand{position:absolute;font-family:'Caveat',cursive;font-size:19px;font-weight:700;color:#F2673A;line-height:1;white-space:nowrap}
.doodle{position:absolute;left:0;top:0;pointer-events:none}
`;

// Scenes that show what TeamGrid catches going wrong: distracting apps, idle time, late logins, meeting load.
Object.assign(I, {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
});
Object.assign(AV, { V: "#0ea5e9", S: "#e0a100" });
const C = { P: "#2DBDB8", N: "#a5b4fc", D: "#ef4444", I: "#fbbf24", M: "#6C59A6", W: "#25d366", E: "#94a3b8" };
const seg = (parts, h = 10) => `<div class="sb" style="height:${h}px">${parts.map(([c, m]) => `<i style="background:${C[c] ?? c};flex:${m}"></i>`).join("")}</div>`;
const legend = (items) => `<div class="lg">${items.map(([c, t]) => `<span><i style="background:${C[c] ?? c}"></i>${t}</span>`).join("")}</div>`;
const appIc = (bg, t) => `<span class="ap" style="background:${bg}">${t}</span>`;

const NEG = `
.sb{display:flex;border-radius:5px;overflow:hidden;gap:1.5px;flex:1}
.sb i{display:block}
.lg{display:flex;gap:9px;font-size:8.5px;font-weight:700;color:#64748b}
.lg span{display:flex;align-items:center;gap:3px}
.lg i{width:7px;height:7px;border-radius:2px}
.hand{color:#dc2626}
.chip{white-space:nowrap}
h1{font-size:23px}
.copy{width:240px}
.ap{width:15px;height:15px;border-radius:4px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:8px;font-weight:800}
.chip.red{color:#b91c1c;background:#fee2e2}
.chip.amb{color:#b45309;background:#fef3c7}
.num{font-variant-numeric:tabular-nums}
`;

const scenes = [
  {
    key: "welcome", bg: "#fdf0ee", eyebrow: "Yesterday, in numbers",
    h: ["How much of", "yesterday was work?"], sub: "Every morning: productive, distracting and idle time for each person.",
    alt: "TeamGrid's morning report: for each person, productive, distracting and idle time. Rahul spent 2 hours 10 minutes on distracting sites, Vikram 1 hour 40 minutes idle.",
    css: NEG + `
.t{left:266px;top:18px;width:312px;padding:11px 12px 8px}
.t .lg{margin:8px 0 4px}
.pr{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px}
.pr .nm{display:flex;align-items:center;gap:6px;width:62px;font-size:10.5px;font-weight:700}
.pr .v{width:112px;display:flex;justify-content:flex-end;font-size:9.5px;font-weight:700;color:#64748b}
.bad{background:#fef2f2;box-shadow:inset 0 0 0 1.5px #fca5a5}
.h1{left:300px;top:222px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${mark()}Team · Yesterday<span class="r">Online time</span></div>
  ${legend([["P", "Productive"], ["D", "Distracting"], ["I", "Idle"]])}
  <div class="pr"><span class="nm">${av("Priya")}Priya</span>${seg([["P", 400], ["D", 20], ["I", 40]])}<span class="v num">6h 40m work</span></div>
  <div class="pr bad"><span class="nm">${av("Rahul")}Rahul</span>${seg([["P", 270], ["D", 130], ["I", 60]])}<span class="v"><span class="chip red num">2h 10m distracting</span></span></div>
  <div class="pr"><span class="nm">${av("Meera")}Meera</span>${seg([["P", 425], ["D", 15], ["I", 30]])}<span class="v num">7h 05m work</span></div>
  <div class="pr"><span class="nm">${av("Vikram")}Vikram</span>${seg([["P", 310], ["D", 50], ["I", 100]])}<span class="v"><span class="chip amb num">1h 40m idle</span></span></div>
</div>
<div class="hand h1">Rahul: 1h 25m of it on youtube.com</div>`,
  },
  {
    key: "setup", bg: "#e9f5ee", eyebrow: "Setup",
    h: ["Install today.", "See gaps tomorrow"], sub: "Your first report already shows late starts, idle time and distracting apps.",
    alt: "TeamGrid installed today; the first report next morning shows three late logins, 2 hours 15 minutes of idle time and 1 hour 20 minutes on youtube.com.",
    css: NEG + `
.dn{left:266px;top:16px;width:312px;padding:8px 12px;display:flex;align-items:center;gap:7px;font-size:10px;font-weight:700}
.dn .r{margin-left:auto;color:#94a3b8;font-weight:600;font-size:9px}
.rp{left:266px;top:62px;width:312px;padding:11px 12px 6px;border:1.5px solid #2DBDB8;box-shadow:0 0 0 5px rgba(45,189,184,.12),0 14px 30px -12px rgba(15,23,42,.22)}
.f{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid #f1f5f9;font-size:10.5px;font-weight:700;color:#1e293b}
.f:first-of-type{border-top:0;margin-top:4px}
.f .b{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}
.f .b .ic{width:13px;height:13px}
.f small{margin-left:auto;font-size:9px;color:#64748b;font-weight:650}
.h1{left:300px;top:230px;transform:rotate(-3deg);color:#0f766e}`,
    stage: `
<div class="card dn"><span class="chip ok">${ic("check")}Agent installed</span><span class="chip ok">${ic("check")}Team invited</span><span class="r">Today, 3:10 PM</span></div>
<div class="card rp">
  <div class="hd">${mark()}First report<span class="r">Tomorrow, 9:00 AM</span></div>
  <div class="f"><span class="b" style="background:#fef3c7;color:#b45309">${ic("clock")}</span><span class="num">3 late logins after 10:30 AM</span><small>Vikram, Kavya, Rahul</small></div>
  <div class="f"><span class="b" style="background:#fef3c7;color:#b45309">${ic("pause")}</span><span class="num">2h 15m idle across the team</span><small>6 people</small></div>
  <div class="f"><span class="b" style="background:#fee2e2;color:#dc2626">${ic("globe")}</span><span class="num">youtube.com · 1h 20m</span><small>Rahul</small></div>
</div>
<div class="hand h1">that is day one</div>`,
  },
  {
    key: "trust", bg: "#eef0fa", eyebrow: "No screenshots",
    h: ["No screenshots.", "Still see time lost"], sub: "Apps and sites are sorted into productive, neutral and distracting.",
    alt: "TeamGrid's apps and websites view for one person: productive tools on top, then youtube.com, instagram.com and amazon.in flagged as 2 hours of distracting time, with no screenshots or keystrokes taken.",
    css: NEG + `
.t{left:266px;top:14px;width:312px;padding:10px 12px 8px}
.a{display:flex;align-items:center;gap:7px;padding:4px 5px;border-radius:6px;font-size:10px;font-weight:700;color:#1e293b}
.a .nm{width:84px}
.a .bar{flex:1;height:5px;border-radius:5px;background:#f1f5f9;overflow:hidden}
.a .bar i{display:block;height:100%;border-radius:5px;background:var(--c);width:var(--w)}
.a .tm{width:44px;text-align:right;font-size:9.5px}
.a .ct{width:62px;display:flex;justify-content:flex-end}
.a.bad{background:#fef2f2}
.ft{display:flex;align-items:center;gap:5px;margin-top:6px;padding-top:6px;border-top:1px dashed #e2e8f0;font-size:9px;font-weight:700;color:#0f766e}
.ft .ic{width:11px;height:11px}
.ft b{margin-left:auto;color:#dc2626}
.h1{left:300px;top:228px;transform:rotate(-3deg)}`,
    stage: (() => {
      const row = (icn, n, t, w, c, cat, bad) => `<div class="a${bad ? " bad" : ""}">${icn}<span class="nm">${n}</span><span class="bar" style="--c:${c};--w:${w}"><i></i></span><span class="tm num">${t}</span><span class="ct">${cat}</span></div>`;
      const P = `<span class="chip ok">Productive</span>`, N = `<span class="chip grey">Neutral</span>`, D = `<span class="chip red">Distracting</span>`;
      return `
<div class="card t">
  <div class="hd">${mark()}Apps and websites · Rahul<span class="r">Today</span></div>
  <div style="margin-top:6px">
  ${row(appIc("#2f80ed", "&lt;/&gt;"), "VS Code", "3h 12m", "100%", C.P, P)}
  ${row(appIc("#a259ff", "F"), "Figma", "1h 40m", "52%", C.P, P)}
  ${row(appIc("#00897b", "M"), "Google Meet", "55m", "29%", "#94a3b8", N)}
  ${row(appIc("#ff0000", "▶"), "youtube.com", "1h 05m", "34%", C.D, D, 1)}
  ${row(appIc("#d62976", "◎"), "instagram.com", "34m", "18%", C.D, D, 1)}
  ${row(appIc("#232f3e", "a"), "amazon.in", "22m", "11%", C.D, D, 1)}
  </div>
  <div class="ft">${ic("check")}No screenshots · no keystrokes<b class="num">2h 01m distracting</b></div>
</div>`;
    })(),
  },
  {
    key: "meetings", bg: "#f3effa", eyebrow: "Meeting load",
    h: ["4 hours of calls.", "1 hour of work"], sub: "Sneha's Tuesday, as TeamGrid saw it. See what meetings really take.",
    alt: "Sneha's Tuesday in TeamGrid: 4 hours 5 minutes in meetings, 1 hour 55 minutes on email and chat, only 1 hour 10 minutes of focused work, 50 minutes idle.",
    css: NEG + `
.t{left:266px;top:18px;width:312px;padding:11px 12px 10px}
.ax{display:flex;justify-content:space-between;font-size:8px;font-weight:700;color:#94a3b8;margin-top:4px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}
.tl{border-radius:8px;padding:6px 7px;background:#f8fafc;border:1px solid #eef2f6}
.tl small{display:flex;align-items:center;gap:4px;font-size:7.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#64748b}
.tl small i{width:6px;height:6px;border-radius:2px;background:var(--c)}
.tl b{display:block;font-size:14px;font-weight:800;margin-top:2px;letter-spacing:-.02em}
.tl.hot{background:#f3eefa;border-color:#d8ccf0}
.tl.low{background:#fef2f2;border-color:#fecaca}
.tl.low b{color:#dc2626}
.h1{left:420px;top:214px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${mark()}Sneha · Tuesday<span class="r">10 AM to 6 PM</span></div>
  <div style="display:flex;margin-top:10px">${seg([["M", 60], ["E", 20], ["M", 45], ["P", 30], ["M", 60], ["I", 30], ["E", 40], ["M", 80], ["P", 40], ["E", 55], ["I", 20]], 26)}</div>
  <div class="ax"><span>10 AM</span><span>12 PM</span><span>2 PM</span><span>4 PM</span><span>6 PM</span></div>
  <div class="tiles">
    <div class="tl hot" style="--c:${C.M}"><small><i></i>Meetings</small><b class="num">4h 05m</b></div>
    <div class="tl" style="--c:${C.E}"><small><i></i>Email</small><b class="num">1h 55m</b></div>
    <div class="tl low" style="--c:${C.P}"><small><i></i>Focused</small><b class="num">1h 10m</b></div>
    <div class="tl" style="--c:${C.I}"><small><i></i>Idle</small><b class="num">50m</b></div>
  </div>
</div>
${doodle(428, 222, 452, 166, -10, "#dc2626")}
<div class="hand h1">the actual work</div>`,
  },
  {
    key: "focus", bg: "#e8f0fa", eyebrow: "Focus",
    h: ["WhatsApp: 1h 38m.", "Longest focus: 14m"], sub: "See how broken up each person's day really is.",
    alt: "Aarav's day in TeamGrid, broken into small pieces: 1 hour 38 minutes on WhatsApp Web, 52 minutes on distracting sites, and no stretch of focused work longer than 14 minutes.",
    css: NEG + `
.t{left:266px;top:18px;width:312px;padding:11px 12px 10px}
.t .lg{margin-top:6px}
.ax{display:flex;justify-content:space-between;font-size:8px;font-weight:700;color:#94a3b8;margin-top:4px}
.st{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}
.s{border-radius:8px;padding:6px 8px;border:1px solid #eef2f6;background:#f8fafc}
.s small{display:block;font-size:7.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#64748b}
.s b{display:block;font-size:15px;font-weight:800;margin-top:2px;letter-spacing:-.02em}
.s.r{background:#fef2f2;border-color:#fecaca}.s.r b{color:#dc2626}
.s.g{background:#ecfdf3;border-color:#bbf7d0}.s.g b{color:#15803d}
.cmp{font-size:8.5px;font-weight:650;color:#64748b;margin-top:7px}
.h1{left:300px;top:230px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${av("Aarav")}Aarav · Today<span class="r">Online 8h 05m</span></div>
  <div style="display:flex;margin-top:9px">${seg([["P", 12], ["W", 6], ["P", 14], ["D", 8], ["P", 9], ["W", 10], ["I", 5], ["P", 11], ["W", 7], ["P", 13], ["D", 12], ["P", 8], ["W", 9], ["P", 14], ["I", 10], ["P", 10], ["W", 12], ["D", 9], ["P", 12], ["W", 8], ["P", 7], ["D", 11], ["P", 13], ["W", 14], ["I", 8], ["P", 12], ["D", 12], ["P", 9], ["W", 10], ["P", 14], ["W", 12]], 24)}</div>
  ${legend([["P", "Work"], ["W", "WhatsApp Web"], ["D", "Distracting"], ["I", "Idle"]])}
  <div class="st">
    <div class="s r"><small>Longest focus</small><b class="num">14m</b></div>
    <div class="s g"><small>WhatsApp Web</small><b class="num">1h 38m</b></div>
    <div class="s r"><small>Distracting</small><b class="num">52m</b></div>
  </div>
  <div class="cmp">Team average longest focus: 48m</div>
</div>
<div class="hand h1">never more than 14 minutes at a stretch</div>`,
  },
  {
    key: "summary", bg: "#fdf0e7", eyebrow: "6 pm summary",
    h: ["The 6 pm summary", "names the problems"], sub: "Late starts, idle hours, distracting sites and blocked work, every evening.",
    alt: "TeamGrid's evening summary listing the day's problems by name: Rahul 1 hour 15 minutes on youtube.com, Kavya 1 hour 40 minutes idle, Vikram logged in at 11:12 AM, Priya blocked for 4 hours.",
    css: NEG + `
.t{left:266px;top:16px;width:312px;padding:11px 12px 7px}
.f{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #f1f5f9;font-size:10.5px;font-weight:700;color:#1e293b}
.f:first-of-type{border-top:0;margin-top:3px}
.f .b{width:21px;height:21px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}
.f .b .ic{width:12px;height:12px}
.f small{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:9.5px;color:#334155;font-weight:700}
.f small em{font-style:normal;color:#94a3b8;font-weight:600}
.h1{left:300px;top:232px;transform:rotate(-3deg)}`,
    stage: (() => {
      const f = (bg, col, icn, what, who, note = "") => `<div class="f"><span class="b" style="background:${bg};color:${col}">${ic(icn)}</span><span class="num">${what}</span><small>${note ? `<em>${note}</em>` : ""}${av(who)}${who}</small></div>`;
      return `
<div class="card t">
  <div class="hd">${mark()}Today's summary<span class="r">6:00 PM</span></div>
  ${f("#fee2e2", "#dc2626", "globe", "Distracting 1h 15m", "Rahul", "youtube.com")}
  ${f("#fef3c7", "#b45309", "pause", "Idle 1h 40m", "Kavya")}
  ${f("#fef3c7", "#b45309", "clock", "Late login, 11:12 AM", "Vikram")}
  ${f("#ffedd5", "#c2410c", "block", "Blocked 4h", "Priya", "client files")}
  ${f("#dcfce7", "#15803d", "check", "14 tasks closed", "Meera", "team")}
</div>
<div class="hand h1">named, not guessed</div>`;
    })(),
  },
  {
    key: "people", bg: "#e8f1fb", eyebrow: "Workload",
    h: ["Meera: 46 hours.", "Rahul: 22"], sub: "Productive hours, same team, same week. Ready at appraisal time.",
    alt: "TeamGrid's weekly view of productive hours per person: Meera 46 hours, Kavya 38, Aarav 35, Rahul 22 with 11 hours on distracting sites.",
    css: NEG + `
.t{left:266px;top:18px;width:312px;padding:11px 12px 9px}
.hl{display:flex;justify-content:space-between;font-size:8px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:#94a3b8;padding:0 6px 3px;margin-top:8px}
.r{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:8px;font-size:10.5px;font-weight:700;color:#1e293b}
.r .nm{display:flex;align-items:center;gap:6px;width:62px}
.r .bar{flex:1;height:9px;border-radius:5px;background:#f1f5f9;overflow:hidden;display:flex}
.r .bar i{display:block;height:100%}
.r .h{width:30px;text-align:right;font-size:11px;font-weight:800}
.r .c{width:92px;display:flex;justify-content:flex-end}
.hi{background:#e6f7f6;box-shadow:inset 0 0 0 1.5px #2DBDB8}
.lo{background:#fef2f2;box-shadow:inset 0 0 0 1.5px #fca5a5}
.h1{left:350px;top:224px;transform:rotate(-3deg)}`,
    stage: (() => {
      const r = (n, h, cls, chip, dist = 0) => `<div class="r ${cls}"><span class="nm">${av(n)}${n}</span><span class="bar"><i style="width:${(h / 48) * 100}%;background:${cls === "lo" ? "#f59e0b" : C.P}"></i>${dist ? `<i style="width:${(dist / 48) * 100}%;background:${C.D}"></i>` : ""}</span><span class="h num">${h}h</span><span class="c">${chip}</span></div>`;
      return `
<div class="card t">
  <div class="hd">${mark()}This week · productive hours</div>
  <div class="hl"><span>Person</span><span>Productive + distracting</span></div>
  ${r("Meera", 46, "hi", `<span class="chip teal">${ic("star")}Carrying</span>`)}
  ${r("Kavya", 38, "", `<span class="chip grey">Steady</span>`, 3)}
  ${r("Aarav", 35, "", `<span class="chip grey">Steady</span>`, 4)}
  ${r("Rahul", 22, "lo", `<span class="chip red num">11h distracting</span>`, 11)}
</div>
<div class="hand h1">same team, same week</div>`;
    })(),
  },
  {
    key: "early", bg: "#fdf4e3", eyebrow: "Early warning",
    h: ["Idle time doubled.", "Nobody told you"], sub: "Vikram went from 45m to 1h 30m idle a day. TeamGrid flags it the week it starts.",
    alt: "Vikram's idle time per day in TeamGrid, rising from 45 minutes in June to 1 hour 30 minutes in September, flagged the week it began.",
    css: NEG + `
.ch{left:266px;top:14px;width:312px;height:180px;padding:11px 12px}
.plot{position:absolute;left:12px;top:40px}
.axis{position:absolute;left:14px;right:14px;bottom:8px;display:flex;justify-content:space-between;font-size:8px;font-weight:700;color:#94a3b8}
.tag{position:absolute;font-size:8.5px;font-weight:800;border-radius:6px;padding:3px 6px;display:flex;align-items:center;gap:4px;white-space:nowrap}
.tag .ic{width:10px;height:10px}
.val{position:absolute;font-size:9px;font-weight:800}
.na{left:300px;top:190px;width:262px;padding:8px 10px;border-left:3px solid #f59e0b}
.na .k{display:flex;align-items:center;gap:5px;font-size:8px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:#b45309}
.na .k .ic{width:11px;height:11px}
.na p{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;color:#1e293b;margin-top:3px}`,
    stage: (() => {
      const mins = [45, 44, 47, 45, 52, 58, 64, 70, 76, 82, 86, 90];
      const bars = mins.map((m, i) => `<rect x="${i * 24 + 5}" y="${112 - m * 1.1}" width="14" height="${m * 1.1}" rx="3" fill="${i >= 4 ? "#fbbf24" : "#e2e8f0"}"/>`).join("");
      return `
<div class="card ch">
  <div class="hd">${mark()}Vikram · idle time per day<span class="r">Weekly</span></div>
  <svg class="plot" width="288" height="116" viewBox="0 0 288 116">${bars}
    <line x1="101" y1="0" x2="101" y2="112" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 3"/>
  </svg>
  <div class="val num" style="left:14px;top:74px;color:#64748b">45m</div>
  <div class="val num" style="left:266px;top:40px;color:#b45309">1h 30m</div>
  <div class="tag" style="left:118px;top:38px;background:#0f766e;color:#fff">${ic("flag")}TeamGrid flags it here</div>
  <div class="axis"><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span></div>
</div>
<div class="card na">
  <div class="k">${ic("alert")}Needs attention</div>
  <p>${av("Vikram")}<span class="num">Idle 1h 30m a day, up from 45m</span></p>
</div>`;
    })(),
  },
  {
    key: "hours", bg: "#e6f5f4", eyebrow: "Where hours went",
    h: ["8 hours online.", "3 were not work"], sub: "Rohan's day, app by app, with no timesheet to fill.",
    alt: "Where Rohan's 8 hours went in TeamGrid: 5 hours of work in Cursor, Google Docs and Teams, and 3 hours not on work, on youtube.com, instagram.com, amazon.in and idle.",
    css: NEG + `
.w{left:266px;top:14px;width:312px;height:232px;padding:11px 12px}
.dn{position:absolute;left:12px;top:48px}
.ctr{position:absolute;left:12px;top:48px;width:104px;height:104px;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ctr b{font-size:16px;font-weight:800;letter-spacing:-.02em}
.ctr small{font-size:8px;font-weight:700;color:#64748b}
.kk{position:absolute;left:14px;top:162px;width:100px;font-size:8.5px;font-weight:700;color:#64748b;line-height:1.6}
.kk i{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px;vertical-align:0}
.ls{position:absolute;left:128px;top:38px;right:12px}
.gh{display:flex;justify-content:space-between;font-size:8px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;margin:6px 0 2px}
.it{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:#1e293b;padding:3px 4px;border-radius:5px}
.it .ap{width:13px;height:13px;font-size:7px}
.it span.t{margin-left:auto;font-size:9.5px}
.it.bad{background:#fef2f2}
.it.bad span.t{color:#dc2626}`,
    stage: (() => {
      const r = 42, Cc = 2 * Math.PI * r, work = 5 / 8;
      const donut = `<svg class="dn" width="104" height="104" viewBox="0 0 104 104"><circle cx="52" cy="52" r="${r}" fill="none" stroke="${C.D}" stroke-width="13"/><circle cx="52" cy="52" r="${r}" fill="none" stroke="${C.P}" stroke-width="13" stroke-dasharray="${(Cc * work).toFixed(1)} ${Cc.toFixed(1)}" transform="rotate(-90 52 52)"/></svg>`;
      const it = (icn, n, t, bad) => `<div class="it${bad ? " bad" : ""}">${icn}${n}<span class="t num">${t}</span></div>`;
      return `
<div class="card w">
  <div class="hd">${mark()}Where hours went · Rohan<span class="r">Yesterday</span></div>
  ${donut}<div class="ctr"><b class="num">8h 00m</b><small>online</small></div>
  <div class="kk"><i style="background:${C.P}"></i>Work 5h 00m<br><i style="background:${C.D}"></i>Not work 3h 00m</div>
  <div class="ls">
    <div class="gh" style="color:#0f766e"><span>Work</span><span class="num">5h 00m</span></div>
    ${it(appIc("#111827", "C"), "Cursor", "2h 45m")}
    ${it(appIc("#1a73e8", "D"), "Google Docs", "1h 20m")}
    ${it(appIc("#5b5fc7", "T"), "Teams", "55m")}
    <div class="gh" style="color:#dc2626"><span>Not work</span><span class="num">3h 00m</span></div>
    ${it(appIc("#ff0000", "▶"), "youtube.com", "1h 15m", 1)}
    ${it(appIc("#d62976", "◎"), "instagram.com", "42m", 1)}
    ${it(appIc("#232f3e", "a"), "amazon.in", "23m", 1)}
    ${it(appIc("#94a3b8", "Z"), "Idle", "40m", 1)}
  </div>
</div>`;
    })(),
  },
];

// Eleven more "what TeamGrid catches" pictures, for the mails that had none.
Object.assign(I, {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  rupee: '<path d="M7 5h10M7 9h10M8 5c5 0 5 8 0 8H7l7 7"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  down: '<path d="M12 4v12M6 12l6 6 6-6"/>',
});
const T2 = `
.tb{width:100%;border-collapse:collapse;font-size:10px;font-weight:700;color:#1e293b}
.tb th{font-size:7.5px;letter-spacing:.07em;text-transform:uppercase;color:#94a3b8;font-weight:800;text-align:left;padding:0 5px 4px}
.tb td{padding:5px;border-top:1px solid #f1f5f9;white-space:nowrap}
.tb td.r,.tb th.r{text-align:right}
.tb tr.bad td{background:#fef2f2}
.tb tr.amb td{background:#fffbeb}
.who{display:inline-flex;align-items:center;gap:5px}
.t{left:266px;top:18px;width:312px;padding:11px 12px 9px}
`;
const scenes2 = [
  {
    key: "attendance", bg: "#fdf4e3", eyebrow: "Attendance",
    h: ["Punched in at 9:31.", "Work started at 10:45"], sub: "The real start of work, in office or at home, without a punch clock.",
    alt: "TeamGrid attendance for four people: punch time next to the time real work started. One person punched in at 9:31 but started work at 10:45; one person working from home started at 11:05.",
    css: NEG + T2 + `.h1{left:330px;top:214px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${mark()}Start of work · Today<span class="r">From computer activity</span></div>
  <table class="tb" style="margin-top:8px"><tr><th>Person</th><th>Punch</th><th>Work started</th><th class="r">Gap</th></tr>
  <tr><td><span class="who">${av("Priya")}Priya</span></td><td class="num">9:28</td><td class="num">9:35</td><td class="r"><span class="chip ok">On time</span></td></tr>
  <tr class="bad"><td><span class="who">${av("Rahul")}Rahul</span></td><td class="num">9:31</td><td class="num">10:45</td><td class="r"><span class="chip red num">1h 14m</span></td></tr>
  <tr class="amb"><td><span class="who">${av("Kavya")}Kavya</span></td><td>WFH</td><td class="num">11:05</td><td class="r"><span class="chip amb">Late start</span></td></tr>
  <tr><td><span class="who">${av("Vikram")}Vikram</span></td><td class="num">9:40</td><td class="num">9:52</td><td class="r"><span class="chip ok">On time</span></td></tr>
  </table>
</div>
<div class="hand h1">the punch said 9:31</div>`,
  },
  {
    key: "payroll", bg: "#eef0fa", eyebrow: "Payroll",
    h: ["3 days of chasing.", "Or one export"], sub: "Timesheets, leave and half days, filled in from real work.",
    alt: "Left: three month-end days spent chasing timesheets, fixing leave and settling half-day disputes. Right: TeamGrid's payroll export with every timesheet filled automatically.",
    css: NEG + `
.cal{left:262px;top:26px;width:120px;padding:9px 10px;transform:rotate(-3deg);opacity:.92}
.cal .hd{font-size:10px}
.dy{display:flex;gap:6px;align-items:center;margin-top:7px;font-size:9px;font-weight:700;color:#b91c1c;background:#fef2f2;border-radius:6px;padding:5px 6px}
.dy b{font-size:12px;color:#0f172a;width:18px}
.px{left:396px;top:18px;width:182px;padding:11px 12px}
.pl{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:#1e293b;padding:6px 0;border-top:1px solid #f1f5f9}
.pl .ic{width:12px;height:12px;color:#16a34a}
.pl b{margin-left:auto;font-size:9.5px;color:#0f766e}
.btn{margin-top:9px;display:flex;align-items:center;justify-content:center;gap:5px;background:#0f766e;color:#fff;border-radius:7px;padding:7px;font-size:10px;font-weight:800}
.btn .ic{width:12px;height:12px}
.h1{left:276px;top:212px;transform:rotate(-4deg)}`,
    stage: `
<div class="card cal"><div class="hd">${ic("cal")}Month end</div>
  <div class="dy"><b>28</b>Chasing timesheets</div>
  <div class="dy"><b>29</b>Fixing leave</div>
  <div class="dy"><b>30</b>Half-day disputes</div>
</div>
<div class="card px">
  <div class="hd">${mark()}Payroll · September</div>
  <div style="margin-top:6px">
  <div class="pl">${ic("check")}Timesheets<b class="num">48 of 48</b></div>
  <div class="pl">${ic("check")}Leave and holidays<b>Synced</b></div>
  <div class="pl">${ic("check")}Half days found<b class="num">3</b></div>
  </div>
  <div class="btn">${ic("down")}Export payroll</div>
</div>
<div class="hand h1">every single month</div>`,
  },
  {
    key: "client", bg: "#fdf0ee", eyebrow: "Client profit",
    h: ["₹50,000 fee.", "₹64,000 of salary"], sub: "Hours by client, filled in on their own, set against the fee.",
    alt: "TeamGrid's hours by client for one month: Client A pays ₹50,000 but took 160 hours, ₹64,000 of salary, a loss of ₹14,000. Clients B and C are profitable.",
    css: NEG + T2 + `.ft{font-size:8.5px;color:#64748b;font-weight:650;margin-top:6px}.h1{left:320px;top:220px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${mark()}Hours by client · September</div>
  <table class="tb" style="margin-top:8px"><tr><th>Client</th><th class="r">Fee</th><th class="r">Hours</th><th class="r">Salary cost</th><th class="r">Result</th></tr>
  <tr class="bad"><td>Client A</td><td class="r num">₹50,000</td><td class="r num">160</td><td class="r num">₹64,000</td><td class="r"><span class="chip red num">−₹14,000</span></td></tr>
  <tr><td>Client B</td><td class="r num">₹80,000</td><td class="r num">120</td><td class="r num">₹48,000</td><td class="r"><span class="chip ok num">+₹32,000</span></td></tr>
  <tr><td>Client C</td><td class="r num">₹30,000</td><td class="r num">50</td><td class="r num">₹20,000</td><td class="r"><span class="chip ok num">+₹10,000</span></td></tr>
  </table>
  <div class="ft">Salary cost at ₹400 an hour · no timesheets filled</div>
</div>
<div class="hand h1">busy client, losing money</div>`,
  },
  {
    key: "workload", bg: "#e8f1fb", eyebrow: "Workload",
    h: ["3 people do", "half the work"], sub: "Productive hours this week, for a 10-person team.",
    alt: "Bar chart of a 10-person team's productive hours this week: the top three people did 150 of 300 hours, half of all the work.",
    css: NEG + `
.w{left:266px;top:16px;width:312px;height:196px;padding:11px 12px}
.ch{position:absolute;left:14px;right:14px;bottom:30px;height:118px;display:flex;align-items:flex-end;gap:7px}
.col{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
.col b{font-size:8.5px;font-weight:800;color:#334155}
.col i{display:block;width:100%;border-radius:4px 4px 2px 2px;background:var(--c)}
.col span{font-size:8px;font-weight:800;color:#fff;width:15px;height:15px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--a)}
.br{position:absolute;left:12px;top:36px;width:88px;border-top:2px solid #0f766e;text-align:center}
.br em{position:relative;top:-9px;background:#0f766e;color:#fff;font-style:normal;font-size:8.5px;font-weight:800;border-radius:5px;padding:2px 6px}
.nt{left:300px;top:218px;display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:10px;font-weight:700;color:#b45309;border-left:3px solid #f59e0b}
.nt .ic{width:12px;height:12px}`,
    stage: (() => {
      const hs = [["M", 52], ["P", 50], ["A", 48], ["K", 26], ["R", 24], ["V", 22], ["S", 22], ["N", 20], ["Y", 18], ["I", 18]];
      return `
<div class="card w">
  <div class="hd">${mark()}Productive hours · this week<span class="r">300 hours in all</span></div>
  <div class="br"><em>150 hours · half</em></div>
  <div class="ch">${hs.map(([a, h], i) => `<div class="col" style="--c:${i < 3 ? C.P : "#cbd5e1"};--a:${AV[a] ?? "#94a3b8"}"><b class="num">${h}h</b><i style="height:${h * 1.6}px"></i><span>${a}</span></div>`).join("")}</div>
</div>
<div class="card nt abs">${ic("alert")}The top 3 are at burnout risk</div>`;
    })(),
  },
  {
    key: "emailwait", bg: "#e6f5f4", eyebrow: "Client email",
    h: ["A client email,", "waiting 3 days"], sub: "How long emails wait for a reply, by client and by team.",
    alt: "TeamGrid Email Insights: an invoice query from Client A has waited 3 days and 4 hours for a reply, a change request 1 day; the accounts team replies in 19 hours on average, support in 2.",
    css: NEG + T2 + `
.tm{display:flex;gap:6px;margin-top:9px}
.tm div{flex:1;border-radius:8px;padding:6px 8px;background:#f8fafc;border:1px solid #eef2f6}
.tm small{display:block;font-size:7.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b}
.tm b{font-size:13px;font-weight:800}
.tm .rd{background:#fef2f2;border-color:#fecaca}.tm .rd b{color:#dc2626}
.h1{left:300px;top:226px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${mark()}Waiting for a reply<span class="r">Google Workspace</span></div>
  <table class="tb" style="margin-top:7px"><tr><th>Client</th><th>About</th><th class="r">Waiting</th></tr>
  <tr class="bad"><td>Client A</td><td>Invoice query</td><td class="r"><span class="chip red num">3d 4h</span></td></tr>
  <tr class="amb"><td>Client B</td><td>Change request</td><td class="r"><span class="chip amb num">1d 2h</span></td></tr>
  <tr><td>Client C</td><td>Proposal</td><td class="r"><span class="chip grey num">5h</span></td></tr>
  </table>
  <div class="tm"><div class="rd"><small>Accounts team, average</small><b class="num">19h</b></div><div><small>Support team, average</small><b class="num">2h</b></div></div>
</div>
<div class="hand h1">reminder sent to the owner</div>`,
  },
  {
    key: "deals", bg: "#fdf0e7", eyebrow: "Sales",
    h: ["₹9 lakh in deals,", "gone quiet"], sub: "Deals with no activity for a week, found on their own.",
    alt: "TeamGrid CRM alert: three deals worth ₹9 lakh together have had no activity for 9 to 16 days.",
    css: NEG + T2 + `
.tot{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding:7px 9px;border-radius:8px;background:#fef2f2;font-size:10.5px;font-weight:800;color:#b91c1c}
.h1{left:300px;top:224px;transform:rotate(-3deg)}`,
    stage: `
<div class="card t">
  <div class="hd">${mark()}Deals gone quiet<span class="r">No activity 7+ days</span></div>
  <table class="tb" style="margin-top:7px"><tr><th>Deal</th><th>Owner</th><th class="r">Value</th><th class="r">Quiet for</th></tr>
  <tr><td>Deal 1 · quote sent</td><td><span class="who">${av("Aarav")}Aarav</span></td><td class="r num">₹3.0 lakh</td><td class="r"><span class="chip red num">16 days</span></td></tr>
  <tr><td>Deal 2 · demo done</td><td><span class="who">${av("Meera")}Meera</span></td><td class="r num">₹2.5 lakh</td><td class="r"><span class="chip red num">11 days</span></td></tr>
  <tr><td>Deal 3 · pricing asked</td><td><span class="who">${av("Aarav")}Aarav</span></td><td class="r num">₹3.5 lakh</td><td class="r"><span class="chip amb num">9 days</span></td></tr>
  </table>
  <div class="tot"><span>Total gone quiet</span><span class="num">₹9.0 lakh</span></div>
</div>
<div class="hand h1">nobody followed up</div>`,
  },
  {
    key: "ask", bg: "#eef0fa", eyebrow: "Ask TeamGrid",
    h: ["Ask in plain English.", "Get the real answer"], sub: "Answers come from recorded work, not from opinions.",
    alt: "Ask TeamGrid: the question 'Which project slipped this week, and why?' answered from recorded work: the website revamp slipped 4 days because design waited on client files and developers spent most of Wednesday in meetings.",
    css: NEG + `
.q{left:266px;top:18px;width:312px;padding:9px 11px;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;color:#0f172a}
.q .ic{width:14px;height:14px;color:#64748b}
.a{left:266px;top:66px;width:312px;padding:11px 12px}
.a p{font-size:10.5px;font-weight:600;color:#1e293b;line-height:1.45;margin-top:6px}
.a p b{color:#dc2626}
.src{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}
.h1{left:310px;top:226px;transform:rotate(-3deg);color:#0f766e}`,
    stage: `
<div class="card q">${ic("search")}Which project slipped this week, and why?</div>
<div class="card a">
  <div class="hd">${mark()}Answer</div>
  <p><b>Website revamp slipped 4 days.</b> Design waited 2.5 days for client files. Two of three developers spent most of Wednesday in meetings.</p>
  <div class="src"><span class="chip grey">From: hours by project</span><span class="chip grey">Meeting time</span><span class="chip grey">Hand-offs</span></div>
</div>
<div class="hand h1">no calls, no waiting</div>`,
  },
  {
    key: "monday", bg: "#e9f5ee", eyebrow: "Founder's Report",
    h: ["Monday, 9 AM.", "Your week, one page"], sub: "Wins, risks and the week ahead, before the Monday review.",
    alt: "TeamGrid's weekly Founder's Report: three wins, two risks (operations spent 41% of the week in meetings; one client took 160 hours on a ₹50,000 fee) and the week ahead.",
    css: NEG + `
.rp{left:266px;top:14px;width:312px;padding:11px 12px 8px}
.sec{margin-top:7px}
.sec small{display:block;font-size:7.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:var(--c);margin-bottom:2px}
.ln{display:flex;align-items:flex-start;gap:6px;font-size:10px;font-weight:650;color:#1e293b;padding:2px 0}
.ln .ic{width:11px;height:11px;margin-top:1px;color:var(--c)}`,
    stage: `
<div class="card rp">
  <div class="hd">${mark()}Founder's Report<span class="r">Monday, 9:00 AM</span></div>
  <div class="sec" style="--c:#15803d"><small>Wins</small>
    <div class="ln">${ic("check")}Payment release shipped two days early</div>
    <div class="ln">${ic("check")}Sales closed two new accounts</div></div>
  <div class="sec" style="--c:#dc2626"><small>Risks</small>
    <div class="ln">${ic("alert")}Operations spent 41% of the week in meetings</div>
    <div class="ln">${ic("alert")}Client A took 160 hours on a ₹50,000 fee</div></div>
  <div class="sec" style="--c:#366EB6"><small>Week ahead</small>
    <div class="ln">${ic("cal")}Two deliveries due Thursday; design is behind</div></div>
</div>`,
  },
  {
    key: "leave", bg: "#fdf4e3", eyebrow: "Leave patterns",
    h: ["5 leaves this quarter.", "All before deadlines"], sub: "Patterns a leave register never shows.",
    alt: "A quarter's timeline for one team member: five deadlines, each with a leave day just before it. TeamGrid flags the pattern.",
    css: NEG + `
.w{left:266px;top:16px;width:312px;height:170px;padding:11px 12px}
.tl{position:absolute;left:16px;right:16px;top:92px;height:3px;background:#e2e8f0;border-radius:3px}
.dl{position:absolute;top:58px;display:flex;flex-direction:column;align-items:center;gap:2px;font-size:7.5px;font-weight:800;color:#0f766e}
.dl .ic{width:13px;height:13px}
.lv{position:absolute;top:100px;width:20px;height:20px;border-radius:6px;background:#fee2e2;color:#b91c1c;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;border:1.5px solid #fca5a5}
.ax{position:absolute;left:16px;right:16px;bottom:10px;display:flex;justify-content:space-between;font-size:8px;font-weight:700;color:#94a3b8}
.lg2{position:absolute;left:12px;top:32px;display:flex;gap:10px;font-size:8.5px;font-weight:700;color:#64748b}
.lg2 span{display:flex;align-items:center;gap:4px}
.na{left:300px;top:196px;width:262px;padding:8px 10px;border-left:3px solid #f59e0b;display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;color:#1e293b}
.na .ic{width:12px;height:12px;color:#b45309}`,
    stage: (() => {
      const ds = [30, 82, 140, 196, 250];
      return `
<div class="card w">
  <div class="hd">${av("Rahul")}Rahul · this quarter<span class="r">Leave and deadlines</span></div>
  <div class="lg2"><span>${ic("flag")}Deadline</span><span><i style="display:inline-block;width:9px;height:9px;border-radius:3px;background:#fee2e2;border:1.5px solid #fca5a5"></i>Leave</span></div>
  <div class="tl"></div>
  ${ds.map((x) => `<div class="dl" style="left:${x + 4}px">${ic("flag")}</div><div class="lv" style="left:${x - 10}px">L</div>`).join("")}
  <div class="ax"><span>Jul</span><span>Aug</span><span>Sep</span></div>
</div>
<div class="card na">${ic("alert")}Pattern flagged: leave lands the day before deadlines</div>`;
    })(),
  },
  {
    key: "overtime", bg: "#fdf0ee", eyebrow: "Overtime",
    h: ["20 hours claimed.", "8 hours worked"], sub: "Real active time after hours, counted on its own.",
    alt: "TeamGrid overtime view for one person in September: 20 overtime hours claimed, 8 hours of real active work after hours, 12 hours with the laptop open and idle.",
    css: NEG + `
.w{left:266px;top:18px;width:312px;padding:11px 12px 10px}
.bx{margin-top:10px}
.bx div{display:flex;align-items:center;gap:8px;margin-top:7px;font-size:10px;font-weight:700;color:#1e293b}
.bx div span.l{width:108px}
.bx div i{display:block;height:14px;border-radius:4px;background:var(--c)}
.bx div b{font-size:11px;font-weight:800}
.st{display:flex;height:14px;border-radius:4px;overflow:hidden;gap:1.5px;flex:none}
.ft{margin-top:10px;padding-top:7px;border-top:1px dashed #e2e8f0;font-size:9px;font-weight:700;color:#0f766e;display:flex;align-items:center;gap:5px}
.ft .ic{width:11px;height:11px}
.h1{left:330px;top:216px;transform:rotate(-3deg)}`,
    stage: `
<div class="card w">
  <div class="hd">${av("Vikram")}Vikram · overtime, September</div>
  <div class="bx">
    <div><span class="l">Claimed</span><i style="--c:#cbd5e1;width:160px"></i><b class="num">20h</b></div>
    <div><span class="l">Real work after hours</span><i style="--c:${C.P};width:64px"></i><b class="num" style="color:#0f766e">8h</b></div>
    <div><span class="l">Laptop open, idle</span><i style="--c:${C.I};width:96px"></i><b class="num" style="color:#b45309">12h</b></div>
  </div>
  <div class="ft">${ic("check")}Active time only. Idle time is never counted.</div>
</div>
<div class="hand h1">12 hours of an open laptop</div>`,
  },
  {
    key: "tools", bg: "#e8f0fa", eyebrow: "Tool costs",
    h: ["4 tools, 4 bills.", "Or one ₹649 seat"], sub: "Time, attendance, HRMS and CRM, in one place, billed in rupees.",
    alt: "Left: four separate tools, a dollar-billed time tracker, an HRMS, a CRM and Excel timesheets, whose data does not match. Right: TeamGrid covers all four for ₹649 per user a month.",
    css: NEG + `
.bl{position:absolute;left:258px;width:140px;white-space:nowrap;padding:7px 9px;font-size:9.5px;font-weight:700;color:#334155;display:flex;align-items:center;gap:6px}
.bl small{margin-left:auto;font-size:8px;color:#b91c1c;font-weight:800}
.mm{position:absolute;left:272px;top:196px;font-size:9px;font-weight:800;color:#b91c1c;background:#fee2e2;border-radius:99px;padding:3px 9px}
.one{left:404px;top:30px;width:174px;padding:11px 12px}
.one .pr{font-size:18px;font-weight:800;margin-top:6px;letter-spacing:-.02em}
.one .pr small{font-size:9px;color:#64748b;font-weight:700}
.ok2{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:#1e293b;padding:4px 0}
.ok2 .ic{width:12px;height:12px;color:#16a34a}`,
    stage: `
<div class="card bl" style="top:22px;transform:rotate(-2deg)">Time tracker<small>$ bill</small></div>
<div class="card bl" style="top:64px;transform:rotate(1.5deg)">HRMS<small>₹ bill</small></div>
<div class="card bl" style="top:106px;transform:rotate(-1deg)">CRM<small>₹ bill</small></div>
<div class="card bl" style="top:148px;transform:rotate(2deg)">Excel timesheets<small>by hand</small></div>
<div class="mm">Data does not match</div>
<div class="card one">
  <div class="hd">${mark()}TeamGrid Advanced</div>
  <div class="pr num">₹649 <small>per user a month</small></div>
  <div style="margin-top:6px">
  <div class="ok2">${ic("check")}Time and attendance</div>
  <div class="ok2">${ic("check")}Timesheets, on their own</div>
  <div class="ok2">${ic("check")}HRMS and payroll export</div>
  <div class="ok2">${ic("check")}CRM</div>
  </div>
</div>`,
  },
];
scenes.push(...scenes2);
mkdirSync(join(OUT, "png"), { recursive: true });
const only = process.argv[2];
for (const s of scenes) {
  if (only && s.key !== only) continue;
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Caveat:wght@600;700&display=block" rel="stylesheet">
<style>${BASE}body{--bg:${s.bg}}${s.css}</style></head><body>
<div class="glow"></div><div class="dots"></div>
<div class="copy"><span class="eyebrow">${mark()}${s.eyebrow}</span><h1>${s.h[0]}<span>${s.h[1]}</span></h1><p class="sub">${s.sub}</p></div>
${s.stage}
</body></html>`;
  const f = join(OUT, `${s.key}.html`);
  writeFileSync(f, html);
  execFileSync(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=600,260", "--virtual-time-budget=6000", `--screenshot=${join(OUT, "png", s.key + ".png")}`, `file://${f}`], { stdio: "ignore" });
  console.log(s.key, s.bg, "|", s.alt);
}
writeFileSync(join(OUT, "meta.json"), JSON.stringify(scenes.map(({ key, bg, alt, h }) => ({ key, bg, alt, caption: h.join(" ") })), null, 1));
