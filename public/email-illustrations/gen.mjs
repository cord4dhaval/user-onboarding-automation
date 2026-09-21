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

const scenes = [
  {
    key: "welcome", bg: "#e8f6f5", eyebrow: "Morning brief",
    h: ["Your team's day,", "written for you"], sub: "Every morning. Nobody types a status update.",
    alt: "TeamGrid morning brief: yesterday's work for each team, written up automatically",
    css: `
.c1{left:270px;top:18px;width:306px;padding:12px 15px 10px}
.s{display:flex;gap:9px;padding:6px 0;border-top:1px solid #f1f5f9}
.s:first-of-type{border-top:0}
.s i{width:3px;border-radius:3px;background:var(--c);flex:none}
.s b{display:block;font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--c);font-weight:800}
.s p{font-size:11.5px;font-weight:650;color:#1e293b;margin-top:2px}
.foot{display:flex;align-items:center;gap:5px;margin-top:6px;padding-top:8px;border-top:1px dashed #e2e8f0;font-size:9.5px;color:#64748b;font-weight:600}
.foot .ic{width:11px;height:11px;color:#34A851}
.h1{left:448px;top:6px;transform:rotate(-4deg)}`,
    stage: `
<div class="card c1">
  <div class="hd">${mark()}AI Summaries <span class="live"><i></i>LIVE</span><span class="r">Yesterday</span></div>
  <div style="margin-top:8px">
  <div class="s" style="--c:#6C59A6"><i></i><div><b>Design</b><p>Shipped the new onboarding screens</p></div></div>
  <div class="s" style="--c:#366EB6"><i></i><div><b>Engineering</b><p>Payment fix merged, one blocker named</p></div></div>
  <div class="s" style="--c:#34A851"><i></i><div><b>Sales</b><p>Demos booked, proposal sent to review</p></div></div>
  <div class="s" style="--c:#F2673A"><i></i><div><b>Operations</b><p>Client handoff ready for Monday</p></div></div>
  </div>
  <div class="foot">${ic("check")}Written by TeamGrid · nobody typed a word</div>
</div>`,
  },
  {
    key: "setup", bg: "#e9f5ee", eyebrow: "Setup",
    h: ["Running by", "this afternoon"], sub: "No IT team. No card. No training.",
    alt: "TeamGrid setup in three steps: install the agent, invite the team, first summary tomorrow morning",
    css: `
.st{left:272px;width:300px;padding:10px 12px;display:flex;align-items:center;gap:11px}
.n{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:12px;flex:none}
.st b{display:block;font-size:12.5px;font-weight:750}
.st small{display:block;font-size:10px;color:#64748b;font-weight:600;margin-top:1px}
.st .chip{margin-left:auto}
.line{position:absolute;left:297px;top:60px;width:2px;height:140px;background:repeating-linear-gradient(#94a3b8 0 4px,transparent 4px 8px)}
.next{border:1.5px dashed #2DBDB8;box-shadow:0 0 0 5px rgba(45,189,184,.12),0 14px 30px -12px rgba(15,23,42,.22)}
.h1{left:430px;top:230px;transform:rotate(-3deg);color:#0f766e}`,
    stage: `
<div class="line"></div>
<div class="card st" style="top:24px"><span class="n" style="background:#0f172a">1</span><div><b>Install the agent</b><small>One small app per computer</small></div><span class="chip ok">${ic("check")}Done</span></div>
<div class="card st" style="top:92px"><span class="n" style="background:#0f766e">2</span><div><b>Invite your team</b><small>One email each, nothing to learn</small></div><span class="chip ok">${ic("check")}Done</span></div>
<div class="card st next" style="top:160px"><span class="n" style="background:#366EB6">3</span><div><b>First summary</b><small>Lands in your inbox</small></div><span class="chip teal">${ic("sun")}Tomorrow morning</span></div>
<div class="hand h1">that is the whole setup</div>`,
  },
  {
    key: "trust", bg: "#eef0fa", eyebrow: "Privacy first",
    h: ["Patterns,", "not surveillance"], sub: "No screenshots. No keystrokes. Ever.",
    alt: "TeamGrid shows work patterns only: screenshots and keystroke logging are never captured, and the team member sees the same view",
    css: `
.p{left:262px;top:24px;width:150px;padding:11px 12px}
.p .t{font-size:9px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:#64748b;margin-bottom:4px}
.tg{display:flex;align-items:center;gap:7px;padding:7px 0;border-top:1px solid #f1f5f9;font-size:11px;font-weight:650;color:#334155}
.tg:first-of-type{border-top:0}
.tg .ic{color:#ef4444;width:15px;height:15px}
.never{margin-left:auto;font-size:8.5px;font-weight:800;color:#ef4444;letter-spacing:.04em;text-transform:uppercase}
.v{left:424px;top:52px;width:156px;padding:12px}
.v .who{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:750}
.pt{margin-top:8px}
.pt div{display:flex;align-items:center;justify-content:space-between;font-size:10px;font-weight:650;color:#334155;margin-top:6px}
.pt u{display:block;height:5px;border-radius:5px;background:#f1f5f9;margin-top:3px;text-decoration:none;overflow:hidden}
.pt u i{display:block;height:100%;border-radius:5px;background:var(--c);width:var(--w)}
.both{display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:8px;border-top:1px dashed #e2e8f0;font-size:9.5px;font-weight:700;color:#0f766e}
.both .av{width:16px;height:16px;font-size:8px}
.both .av+.av{margin-left:-9px}
.h1{left:278px;top:196px;transform:rotate(-4deg)}`,
    stage: `
<div class="card p">
  <div class="t">TeamGrid never takes</div>
  <div class="tg">${ic("cam")}Screenshots<span class="never">Never</span></div>
  <div class="tg">${ic("keys")}Keystrokes<span class="never">Never</span></div>
  <div class="tg">${ic("video")}Recordings<span class="never">Never</span></div>
</div>
<div class="card v">
  <div class="who">${av("Priya")}Priya's week</div>
  <div class="pt">
    <div>Focus time</div><u style="--c:#2DBDB8;--w:78%"><i></i></u>
    <div>Meetings</div><u style="--c:#6C59A6;--w:40%"><i></i></u>
    <div>Waiting on others</div><u style="--c:#F2673A;--w:22%"><i></i></u>
  </div>
  <div class="both">${av("Priya")}${av("You")}Priya sees this too</div>
</div>
${doodle(374, 208, 420, 196, 4)}
<div class="hand h1">nothing hidden</div>`,
  },
  {
    key: "meetings", bg: "#fbf0e6", eyebrow: "Status meetings",
    h: ["Skip the", "status meeting"], sub: "Everyone's update is already written.",
    alt: "Status meetings crossed off the calendar, replaced by TeamGrid's written story of the day",
    css: `
.cal{left:268px;top:30px;width:118px;padding:10px;transform:rotate(-3deg)}
.cal .hd{font-size:10px}
.ev{margin-top:7px;border-radius:6px;padding:6px 7px;font-size:10px;font-weight:700;background:var(--b);color:var(--c);position:relative}
.ev small{display:block;font-size:8.5px;font-weight:600;opacity:.8}
.ev s{text-decoration:line-through;text-decoration-color:#ef4444;text-decoration-thickness:2px}
.ev{opacity:.85}
.story{left:398px;top:22px;width:180px;padding:11px 12px}
.it{display:flex;gap:7px;padding:7px 0;border-top:1px solid #f1f5f9}
.it:first-of-type{border-top:0}
.it p{font-size:10.5px;font-weight:650;color:#1e293b;line-height:1.3}
.it small{display:block;font-size:8.5px;font-weight:700;color:var(--c);text-transform:uppercase;letter-spacing:.06em;margin-bottom:1px}
.arr{position:absolute;left:377px;top:118px;width:26px;height:26px;border-radius:50%;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 14px -4px rgba(15,23,42,.4)}
.arr .ic{width:13px;height:13px}
.h1{left:282px;top:214px;transform:rotate(-4deg)}`,
    stage: `
<div class="card cal">
  <div class="hd">${ic("cal")}Monday</div>
  <div class="ev" style="--b:#e8f0fa;--c:#1d4ed8"><small>10:00</small><s>Standup</s></div>
  <div class="ev" style="--b:#f3eefa;--c:#6C59A6"><small>12:00</small><s>Status review</s></div>
  <div class="ev" style="--b:#fdeee7;--c:#c2410c"><small>16:00</small><s>Weekly sync</s></div>
</div>
<div class="arr">${ic("arrowR")}</div>
<div class="card story">
  <div class="hd">${mark()}Today's story</div>
  <div style="margin-top:6px">
  <div class="it">${av("Priya")}<p><small style="--c:#366EB6">Engineering</small>Closed the payment bug</p></div>
  <div class="it">${av("Rohan")}<p><small style="--c:#6C59A6">Design</small>Pricing page finished</p></div>
  <div class="it">${av("Meera")}<p><small style="--c:#34A851">Sales</small>Sent the client proposal</p></div>
  </div>
</div>
<div class="hand h1">meeting time, back to work</div>`,
  },
  {
    key: "focus", bg: "#e8f0fa", eyebrow: "Focus",
    h: ["Stop asking", "“any update?”"], sub: "The update finds you. Your team keeps working.",
    alt: "Chat messages asking for updates, muted, next to a team member's uninterrupted focus time in TeamGrid",
    css: `
.b{position:relative;background:#d9fdd3;border-radius:10px 10px 2px 10px;padding:5px 8px 4px;font-size:10.5px;font-weight:600;color:#1e293b;margin:0 0 7px auto;width:max-content;max-width:150px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.b small{display:block;text-align:right;font-size:8px;color:#64748b;margin-top:1px}
.b small b{color:#53bdeb}
.chat{position:absolute;left:262px;top:14px;width:172px;opacity:.6}
.muted{position:absolute;left:446px;top:58px;display:flex;align-items:center;gap:5px;background:#fff;border:1px solid #fecaca;color:#dc2626;border-radius:99px;padding:4px 9px;font-size:10px;font-weight:800;box-shadow:0 6px 16px -8px rgba(15,23,42,.3);transform:rotate(-4deg)}
.f{left:300px;top:134px;width:278px;padding:11px 13px}
.f .who{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:750}
.day{display:flex;height:22px;border-radius:6px;overflow:hidden;margin-top:9px;gap:2px}
.day i{display:block;background:var(--c)}
.lbl{display:flex;justify-content:space-between;font-size:8.5px;color:#94a3b8;font-weight:700;margin-top:4px}
.fk{display:flex;align-items:center;gap:5px;margin-top:8px;font-size:10px;font-weight:700;color:#0f766e}
.fk .ic{width:12px;height:12px}
.h1{left:470px;top:40px;transform:rotate(-5deg)}`,
    stage: `
<div class="chat">
  <div class="b">Any update?<small>11:02 <b>✓✓</b></small></div>
  <div class="b">Status on the client file?<small>14:15 <b>✓✓</b></small></div>
  <div class="b">Done yet??<small>17:48 <b>✓✓</b></small></div>
</div>
<div class="muted">${ic("belloff")}Not needed</div>
<div class="card f">
  <div class="who">${av("Aarav")}Aarav's day<span class="chip teal" style="margin-left:auto">${ic("headph")}Deep work</span></div>
  <div class="day"><i style="--c:#cbd5e1;flex:1"></i><i style="--c:#2DBDB8;flex:5"></i><i style="--c:#cbd5e1;flex:1"></i><i style="--c:#2DBDB8;flex:3"></i><i style="--c:#6C59A6;flex:1"></i></div>
  <div class="lbl"><span>Morning</span><span>Afternoon</span><span>Evening</span></div>
</div>
`,
  },
  {
    key: "summary", bg: "#fdf0e7", eyebrow: "Daily summary",
    h: ["No more chasing", "updates at 6 pm"], sub: "Each morning, yesterday is written up for you.",
    alt: "A phone notification from TeamGrid with yesterday's work written up: done items and one waiting on a client",
    css: `
.ph{position:absolute;left:282px;top:16px;width:132px;height:250px;border-radius:24px;background:#0f172a;padding:6px;box-shadow:0 18px 34px -14px rgba(15,23,42,.5)}
.scr{height:100%;border-radius:19px;background:linear-gradient(160deg,#fde2cf,#f6c9b4 45%,#c9b8e8);padding:26px 7px 0;position:relative;overflow:hidden}
.notch{position:absolute;left:50%;top:6px;width:40px;height:10px;border-radius:8px;background:#0f172a;transform:translateX(-50%)}
.tm{text-align:center;color:#fff;font-size:26px;font-weight:700;letter-spacing:-.02em;text-shadow:0 1px 6px rgba(0,0,0,.12)}
.dt{text-align:center;color:#fff;font-size:8.5px;font-weight:700;margin-bottom:10px}
.nt{background:rgba(255,255,255,.93);border-radius:11px;padding:7px 8px;font-size:8.5px;color:#334155;font-weight:600;line-height:1.3}
.nt b{display:flex;align-items:center;gap:4px;font-size:8.5px;color:#0f172a;margin-bottom:2px}
.nt b .mk{width:10px;height:11px}
.nt b em{margin-left:auto;font-style:normal;color:#94a3b8;font-weight:600}
.d{left:408px;top:52px;width:172px;padding:11px 12px}
.d .t{font-size:9px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:#64748b}
.li{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:650;color:#1e293b;padding:6px 0;border-top:1px solid #f1f5f9}
.li:first-of-type{border-top:0}
.li .ic{width:13px;height:13px;flex:none}
.g{color:#16a34a}.a{color:#d97706}
.h1{left:430px;top:222px;transform:rotate(-3deg)}`,
    stage: `
<div class="ph"><div class="scr"><div class="notch"></div>
  <div class="tm">9:00</div><div class="dt">Tuesday morning</div>
  <div class="nt"><b>${mark()}TeamGrid<em>now</em></b>Yesterday, written up: design shipped, sales sent the proposal…</div>
</div></div>
<div class="card d">
  <div class="t">Yesterday</div>
  <div style="margin-top:6px">
  <div class="li">${ic("check", "g")}New screens shipped</div>
  <div class="li">${ic("check", "g")}Payment fix merged</div>
  <div class="li">${ic("check", "g")}Proposal sent</div>
  <div class="li">${ic("alert", "a")}Waiting on client files</div>
  </div>
</div>
<div class="hand h1">already in your inbox</div>`,
  },
  {
    key: "people", bg: "#e8f1fb", eyebrow: "Reviews and raises",
    h: ["Credit the people", "carrying the load"], sub: "Months of real work at review time, not memory",
    alt: "TeamGrid team view over a quarter: one steady contributor highlighted, one teammate flagged as overloaded",
    css: `
.t{left:268px;top:22px;width:310px;padding:11px 12px 9px}
.r{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:8px;font-size:11px;font-weight:700;color:#1e293b}
.r .nm{width:52px}
.sp{display:flex;align-items:flex-end;gap:2px;height:20px;flex:1}
.sp i{flex:1;border-radius:2px;background:var(--c,#cbd5e1)}
.r .chip{width:84px;justify-content:center}
.hi{background:#e6f7f6;box-shadow:inset 0 0 0 1.5px #2DBDB8}
.hl{font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:#94a3b8;display:flex;justify-content:space-between;padding:0 7px 4px}
.h1{left:360px;top:222px;transform:rotate(-3deg)}`,
    stage: (() => {
      const bars = (hs, c) => `<div class="sp" style="--c:${c}">${hs.map((h) => `<i style="height:${h}%"></i>`).join("")}</div>`;
      return `
<div class="card t">
  <div class="hd">${mark()}Team · this quarter</div>
  <div class="hl" style="margin-top:8px"><span>Person</span><span>Week by week</span></div>
  <div class="r">${av("Kavya")}<span class="nm">Kavya</span>${bars([45, 50, 42, 55, 48, 52, 46, 50, 44, 49, 51, 47], "#cbd5e1")}<span class="chip grey">Steady</span></div>
  <div class="r hi">${av("Meera")}<span class="nm">Meera</span>${bars([62, 70, 74, 68, 78, 82, 76, 85, 80, 88, 84, 90], "#2DBDB8")}<span class="chip teal">${ic("star")}Carrying</span></div>
  <div class="r">${av("Rohan")}<span class="nm">Rohan</span>${bars([14, 18, 22, 28, 32, 38, 42, 46, 50, 52, 55, 58], "#469FD8")}<span class="chip" style="color:#1d4ed8;background:#e0ecfb">Ramping up</span></div>
  <div class="r">${av("Aarav")}<span class="nm">Aarav</span>${bars([50, 44, 52, 47, 53, 49, 45, 51, 48, 52, 46, 50], "#cbd5e1")}<span class="chip grey">Steady</span></div>
</div>
<div class="hand h1">the quiet one, doing the most</div>`;
    })(),
  },
  {
    key: "early", bg: "#fdf4e3", eyebrow: "Early warning",
    h: ["Hear it on day one,", "not at resignation"], sub: "Overload and blockers flagged the week they start.",
    alt: "A work trend dipping over weeks: TeamGrid flags it the week it starts, long before a resignation letter",
    css: `
.ch{left:266px;top:16px;width:312px;height:178px;padding:11px 12px}
.ch svg.plot{position:absolute;left:12px;top:36px}
.axis{position:absolute;left:12px;right:12px;bottom:8px;display:flex;justify-content:space-between;font-size:8.5px;font-weight:700;color:#94a3b8}
.tag{position:absolute;font-size:9px;font-weight:800;border-radius:6px;padding:3px 6px;display:flex;align-items:center;gap:4px;white-space:nowrap}
.tag .ic{width:11px;height:11px}
.na{left:318px;top:188px;width:236px;padding:9px 11px;border-left:3px solid #f59e0b}
.lg{display:inline-block;width:8px;height:8px;border-radius:2px;background:#fdba74;margin-right:4px;vertical-align:-1px}
.na .k{display:flex;align-items:center;gap:5px;font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:800;color:#b45309}
.na .k .ic{width:12px;height:12px}
.na p{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#1e293b;margin-top:4px}`,
    stage: `
<div class="card ch">
  <div class="hd">${mark()}Rohan · since June<span class="r"><i class="lg"></i>Late-night work</span></div>
  <svg class="plot" width="288" height="112" viewBox="0 0 288 112">
    <g fill="#fdba74">${[0, 0, 0, 0, 0, 3, 6, 9, 12, 15, 17, 19].map((h, i) => (h ? `<rect x="${i * 24 + 6}" y="${104 - h * 2.2}" width="12" height="${h * 2.2}" rx="2"/>` : "")).join("")}</g>
    <path d="M6 30 L30 28 L54 31 L78 27 L102 29 L126 36 L150 46 L174 57 L198 66 L222 74 L246 80 L276 84" stroke="#2DBDB8" stroke-width="2.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="132" y1="4" x2="132" y2="104" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="3 3"/>
    <line x1="276" y1="4" x2="276" y2="104" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="3 3"/>
    <circle cx="132" cy="38" r="5" fill="#fff" stroke="#0f766e" stroke-width="2.2"/>
  </svg>
  <div class="tag" style="left:88px;top:28px;background:#0f766e;color:#fff">${ic("flag")}TeamGrid flags it</div>
  <div class="tag" style="left:206px;top:28px;background:#f1f5f9;color:#64748b">${ic("mail")}Usually heard here</div>
  <div class="axis"><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span></div>
</div>
<div class="card na">
  <div class="k">${ic("alert")}Needs attention</div>
  <p>${av("Rohan")}Rohan is working late most nights</p>
</div>`,
  },
  {
    key: "hours", bg: "#e6f5f4", eyebrow: "Where hours went",
    h: ["See where", "the hours went"], sub: "By person, project and app, with no timesheets",
    alt: "TeamGrid's where-hours-went view: time split by client and project, filled in without a timesheet",
    css: `
.w{left:268px;top:24px;width:310px;height:208px;padding:12px}
.ring{position:absolute;left:14px;top:48px}
.ls{position:absolute;left:150px;top:44px;right:12px}
.pr{padding:5px 0}
.pr div{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;color:#1e293b}
.pr div i{width:8px;height:8px;border-radius:3px;background:var(--c)}
.pr u{display:block;height:5px;background:#f1f5f9;border-radius:5px;margin-top:4px;overflow:hidden}
.pr u b{display:block;height:100%;width:var(--w);background:var(--c);border-radius:5px}
.nt{position:absolute;left:14px;bottom:12px;display:flex;align-items:center;gap:5px;font-size:9.5px;font-weight:700;color:#0f766e}
.nt .ic{width:12px;height:12px}
.h1{left:350px;top:4px;transform:rotate(-3deg)}`,
    stage: (() => {
      const rings = [["#6C59A6", 0.78], ["#366EB6", 0.55], ["#2DBDB8", 0.4], ["#F2673A", 0.24], ["#cbd5e1", 0.14]];
      const arcs = rings.map(([c, f], i) => { const r = 56 - i * 10, C = 2 * Math.PI * r; return `<circle cx="64" cy="64" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="6"/><circle cx="64" cy="64" r="${r}" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 64 64)"/>`; }).join("");
      const rows = [["Client A · retainer", "#6C59A6", "78%"], ["Client B · launch", "#366EB6", "55%"], ["Internal product", "#2DBDB8", "40%"], ["Meetings", "#F2673A", "24%"]];
      return `
<div class="card w">
  <div class="hd">${mark()}Where hours went<span class="r">This week</span></div>
  <svg class="ring" width="128" height="128" viewBox="0 0 128 128">${arcs}</svg>
  <div class="ls">${rows.map(([n, c, w]) => `<div class="pr" style="--c:${c};--w:${w}"><div><i></i>${n}</div><u><b></b></u></div>`).join("")}</div>
  <div class="nt">${ic("check")}Filled in by TeamGrid, no timesheet</div>
</div>
<div class="hand h1">no Friday chasing</div>`;
    })(),
  },
];

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
