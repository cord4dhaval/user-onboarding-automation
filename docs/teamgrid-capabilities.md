# TeamGrid capabilities map, for sales emails

Built 2026-09-21. Read-only research.

**Sources**
- 30 saved pages from 2026-09-09 (`assets/teamgrid/pages/`): home, features plus 9 feature pages, 10 solution pages, pricing, 7 compare pages, ai-workforce-intelligence (the same as home).
- The live site on 2026-09-21. WebFetch only returned the page title (the site is a React app), so every page was rendered with headless Chrome. Pages that were not in the saved set came from the live site: /monitoring (the "Workforce Analytics" menu item), /hrms, /crm, /email-insights, /pattern-intelligence, /resource-optimizer ("Managed Services"), /security, /download, /about, /help, /solutions, /compare, /time-tracking-software, /employee-monitoring-software, and the /blog index for the report teaser. Some content only appears after a click on the home page (the module showcase, the per-team tabs, the six skill cards). That content was read from the site's JS bundle and is cited as "home (interactive)".
- The idea bank (ideas 1–88) in `docs/learnings.md`, "2026-09-16 — Brainstorm: scenario mails for Indian founders".

**What changed since 2026-09-09.** The copy on the saved pages has not changed. There are four small differences:
1. Feature, solution and blog pages now carry a new top line: "NEW Pattern Intelligence — the first organizational brain for your company".
2. The compare page against Time Doctor now shows TeamGrid at **$6.99** against Time Doctor's $6.70, where it used to show ₹299.
3. The banner "The State of the SMB Workday 2026 — what 3M+ hours reveal" links to /blog-post, but that page is the "every-7th-day pattern" article. The report has no page of its own. The only place it appears is a teaser card on /blog.
4. "Managed Services" is the /resource-optimizer page. "Pattern AI" and "Meet your org's brain" are the hero badge on the home page, and both were already there on 09-09.

**Legend**
- **sample**: a number from a demo screen on the site. We can use it as an illustration, but not as a result.
- **benchmark**: a result TeamGrid claims, marked on the site "Aggregated, anonymized TeamGrid workspace benchmarks, 2026" or "Typical results reported by…".
- **example**: our own simple arithmetic. It must be labelled as an illustration in the mail.
- **Plan:** Std = Standard ₹299, Adv = Advanced ₹649, Ent = Enterprise, plan? = the pricing page does not say which plan includes it.

---

## 1. Time and attendance

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Automatic Time Tracking (Std) | Timesheets written from memory on Friday. Forgotten timers. Hours nobody can check | Wrong invoices and wrong payroll. Friday afternoons spent backfilling | A desktop agent builds worked time from real activity. It detects start, stop and idle, and adds project context without tagging | "0 timers started, 0 entries backfilled, 0 reminders sent"; "31h 40m logged so far" (sample); "Setup 5 min"; "CPU load Minimal" (automatic-time-tracking) | #32, #69, #29 |
| Idle and break handling (Std) | Idle stretches counted as work, or breaks quietly deleted | Paid hours that were not worked. Also staff who distrust the totals | Idle and break time are marked, never counted as active hours. The agent pauses when the person steps away | "Break time is marked, never counted as active"; "Idle and break time handled fairly, not deleted silently" (time-tracking-software); "Auto-pause" (download) | #1, #50 |
| Auto attendance, part of HRMS (Adv) | Punch clocks, biometric queues, and "forgot to punch" requests. Presence for remote staff | HR mornings spent approving corrections. No record for work-from-home staff | Presence is read from real activity by the same agent. No hardware | "Does attendance need biometrics or a punch clock? No hardware at all" (hrms); "96% attendance" (sample, home interactive) | #14, #46, #71, #25 |
| Auto timesheets and payroll export (Std: "Attendance & auto timesheets"; payroll export is shown on HRMS, Adv) | Month-end chasing across spreadsheets, and salary disputes | example: 3 days of HR time a month on the chase | Timesheets build themselves, with leave, holidays and shifts already matched. One-click payroll export | "TIMESHEETS 100% Auto-built… Zero manual entry"; "SPREADSHEETS 0"; "disputes down to near zero" (hrms) | #18, #29 |
| Billable capture per client (plan?) | Short review calls and advisory emails that never reach a timesheet | site: "1.4h recoverable today, 4.8h so far this week" (sample). example: 4.8h × ₹1,500 an hour billing rate = ₹7,200 a week not invoiced | Work is assigned to the right client as it happens. Billable and non-billable time are split, and unlogged time is shown each week | Benchmarks (accounting page): "+22% billable utilization", "+12% revenue realization" | #44, #85, #30 |
| Hours per client or project for invoices (plan?) | A client disputes how many hours the team put in | An argued invoice, or a discount given to end the argument | Hours are attached to each project or client automatically and exported | "81% billable" and "318h across four projects" (sample, time-tracking-software) | #30, #27 |
| Contractor verified hours (plan?) | A contractor bills 160 hours that nobody can see | Paying for hours on trust | Contract staff and employees are measured the same way. Nothing to fill in | "Contractor hours verified from real activity"; "Fair, evidence-based invoicing for both sides" (solutions) | #32 |
| Holidays and Shift Planner (Adv, HRMS) | Shift cover gaps, and US or UK night shifts nobody plans for | Missed cover, and silent overtime | Holiday and shift planning inside HRMS | Listed only: "Holiday & shift planning built in" (hrms); "Shift Planner", "Holidays" (home module list) | #37, #72 |
| Desktop App or Background Agent (all plans) | Staff offline, flaky internet, or no IT team to install anything | Lost hours, and a roll-out that stalls | Desktop App: tray icon, offline mode, manual start and stop. Background Agent: 3 MB, one sign-in, no windows | "Offline mode 0 lost"; "Mac agent 3 MB"; "Version 2.0.4"; macOS 12+, Windows 10/11 64-bit, Ubuntu 20.04+ and Debian (download) | new |

## 2. Productivity and focus

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Productivity Scoring (Std) | Performance judged on gut feel, and problems found only at review time | A struggling week found months late. Appraisals argued from memory | A live score built from 4 signals (active time, focus duration, project work, collaboration). It is compared with the person's own history and team, and every point can be traced | "Signals scored 4"; "History 12 wk"; "+6.2 pts this week"; "Focus duration is up 18% since Wednesdays went meeting-free"; "Two members are trending down three weeks running — both picked up a second project" (all sample, productivity-scoring) | #1, #15, #35, #50, #65, #67 |
| Hourly Breakdown (Std) | A daily average that hides a strong morning and a weak afternoon. The standup placed on the best hour | example: in a 50-person team at ₹40,000 a month, three weak hours a day is about ₹6.7 lakh a month (idea 1) | Each hour gets its own log, score and summary. The peak hours are named, so meetings can move off them | "11:00–12:00 85%", "14:00–15:00 40%"; "Granularity 1 hour" (sample, hourly-breakdown) | #5, #82, #53 |
| Meeting Load / Focus Time (Std, shown on Workforce Analytics) | Meetings that eat the week. Deep work squeezed out | site: "Ops at 41% of the week" (sample, home). example: 41% of a 45-hour week is about 18 hours | The meeting share and the deep-work share are shown per team, so low-value recurring meetings stand out | "MEETING LOAD −22% Typical drop once hourly breakdowns expose the creep" (benchmark, monitoring); "41% of the average Ops week is meetings — 2026 workday data" (blog report teaser) | #6, #49 |
| Meeting Load Guard (skill, Adv) | Standing calls nobody needs. Invites without an agenda | site: "Trimmed 2 standing calls from 12 calendars → 2.5h/week back" (sample) | A skill that watches each team's meeting share and protects maker time. It trims calls, blocks focus time and flags invites with no agenda | "Blocked Wed 9–12 as company focus time → +14% deep focus"; "Flagged 3 invites with no agenda → 3 declined" (sample, home interactive) | #42 |
| Focus Protector (skill, shown as "SUGGESTED") | Rituals that cost more focus than they return | Lost deep-work hours | Proposes dropping a ritual, and waits for approval | "Deep focus climbed 14% on the days engineering skipped standup"; "Make no-meeting Wednesday company-wide — awaiting approval" (sample, home interactive) | #41 |
| Weekday pattern, part of Org Intelligence (Adv) | A weak Monday that nobody noticed | site: "could recover roughly 4 hours a week" (sample) | Productivity by weekday, with a specific fix | "Monday −23%"; "Move Monday standups to 9:30 AM. Teams with early standups show 18% higher Monday productivity"; "HOURS RECOVERED ~4/wk" (sample, org-intelligence) | new |
| Idle, waiting and rework split (plan?, operations) | "Busy" staff who are really waiting on approvals, or redoing the same work | site: "1.9h blocked on approvals"; "36 cases touched more than twice — one form field is the cause" (sample) | Hands-on work, waiting time and rework loops are shown separately per stage and per shift | Benchmarks (operations): "+40% throughput", "−35% cost", "SLA 99.9%", "−50% errors" | new |
| Reactive vs proactive split (plan?, client-driven) | The day eaten by firefighting, so deliverables slip to the evening | site: "Teams that see the split usually take back a full day inside a month" | The share of reactive work, per account and per person, plus suggested protected blocks | "Proactive 38% → 58% over 4 weeks" (sample); "+40% proactive hours" (benchmark, client-driven) | new |
| Timezone overlap and async response (plan?, remote) | Decisions that wait a day because nobody knows when the other half is online | site: "Client review 31h" async response (sample) | Shows the real overlap window and the best sync slot, and where a thread goes cold | "LDN ↔ TKY 1.5h"; "the standing 60-minute sync usually becomes a 10-minute written update" (remote page) | #37 (partly), new |
| Productivity by site and shift (plan?, BPO) | One site doing worse, and nobody can prove why | site: "Bogotá sits 16 points below… a 9h wait on approvals that Manila clears in 40 minutes" (sample) | All sites measured on one scale, so a gap shows up as a process gap and not as blame | Benchmarks (bpo): "−32% quality spread", "28% faster" hand-offs | #25 (partly), new |

## 3. Apps and websites

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| App categories (Std) | Nobody knows which tools the day actually went into | Guesswork about distraction and tools | Every app is sorted automatically into productive, neutral or distracting. Any app can be moved to another category | "204 apps & sites tracked" (typical); "3 categories" (app-website-tracking) | #8 |
| Website time per domain (Std) | Browsing time that nobody can see, done without reading pages | Unseen time drains | Time per domain only. Page content, form entries and anything typed are never stored | "Work tools 72%, Distracting 11%" (sample); "Content captured 0" | #8, #63 |
| Smart alerts (Std) | Managers watching a live feed, or missing a sudden change | Manager time, and trust | One alert when use departs from the person's own normal pattern | "Distracting-category time rose 2.4x on Thursday afternoon across the support pod, right after the queue spiked"; "documentation domains is up +31% in engineering" (sample) | #43 |
| Tool switching per task (Adv, via Ask TeamGrid) | Staff copying between tools, e.g. CRM and billing | site: "Ticket handling time is up 18%… agents touch 4 tools per ticket, up from 2" (sample) | Names the step to fix | "Fix that one hop and the week gets its afternoons back" (ask-teamgrid) | #64 |
| Unused or duplicate software ("Tooling Agent", plan?) | Paid seats nobody opens, and several tools that do the same job | example: 40 seats at ₹1,000 a month with 11 used = ₹29,000 a month wasted | Flags duplicate spend on apps | Only a one-line mention: "Tooling Agent spots redundant app spend"; "Find the hours lost between tools" (home interactive, Operations tab) | #28 |
| Websites & Applications Report (report template, plan?) | Audit requests: which sites and apps, how long | Manual report building | A ready report template | App code only, not on a public page: "Websites & Applications Report — Every website and app they used, with hours" | new (verify) |

## 4. AI summaries and reports

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Daily AI Work Summaries (Std) | Evening "what did you do today?" calls and chasing Slack replies | site: "Managers read four summaries in two minutes instead of chasing four Slack replies" | A plain-language report per person by 6 PM, which the person sees first | "Read time 30 sec" per person per day; "Insights per day 8"; "Written by hand 0" (ai-work-summaries) | #7 |
| Monthly reports (plan?) | Reviews and client updates put together by hand. Work that stalls quietly | Hours spent on month-end write-ups | A month rolled up: where time went, what changed, and what keeps stalling | "Advertising analysis took 3.4x more hours than last month"; "Shopify API research keeps getting picked up and dropped, four separate weeks" (sample) | new |
| Stalled-work watch-item (inside summaries) | A task picked up and dropped week after week | Weeks of half-done work | Named in the summary as a "FLAG" | "Shopify API research opened again and stalled again, week four" (sample) | new |
| Hourly, daily and weekly digests, sent to email or Slack (plan?) | Status meetings | Meeting hours | Digests with wins, risks and follow-ups, pushed out automatically | "Pushed to email or Slack automatically" (monitoring); "Summaries 3×" (compare pages) | #7 |
| Founder's Report (Adv) | The founder has no single view of the week, and a Monday MIS built by hand | site case (Managed Services): "Weekly ops reports… 12 seconds instead of 6 hours" | Monday 9 AM brief with wins, risks and decisions needed. Every claim is linked to its pattern. Weekly and monthly | "5 wins · 3 risks · 2 decisions needed"; "Delivered to email, Slack, or in-app" (pattern-intelligence) | #7, #21, #26 |
| Team briefs by function (Adv) | Each function lead writes their own weekly report | Lead time every week | Friday pipeline brief (sales), support digest, ops weekly, monthly people review | Home (interactive), per-team tabs: "Summary Agent writes the Friday pipeline brief"; "Report Agent drafts the monthly people review" | new |
| One-click, presentation-ready export (plan?) | CSV exports that still need cleaning before a board or client meeting | Analyst hours | Summaries that are ready to present | "Export 1 click. Presentation-ready, not a CSV you still have to clean" (compare-employee-monitoring) | #26, #30 |
| Stakeholder or client report (plan?, BPO) | Clients who doubt a remote team is working | Arguments at renewal | A report ready to show the client | "Client reporting generated automatically" (solutions); "+40% higher satisfaction when performance can be shown" (benchmark, bpo) | #45 |
| Automatic write-up of an SLA miss (plan?) | Post-mortems written days later | Time spent working out the cause | "Automatic write-up of what caused each miss" (operations) | none | #75 |
| Report templates (plan?) | One report does not fit every reader | Hours spent building custom reports | Presets: CEO / Executive Brief, Per-Client / Practice Report, Accounts & Finance Review, Idle Time & Reasons Review, Daily / Weekly Activity Report, and others | App code only, not on a public page. Verify before use | new (verify) |

## 5. People risk and HR

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Burnout Early-Warning (skill) and after-hours creep (Adv) | Silent overtime before burnout | example: losing one senior person on a 60–90 day notice, plus hiring a replacement, costs lakhs | Compares each person with their own rhythm, never with teammates, and raises a quiet flag for the manager | "After-hours work ran at 3× personal baseline for 2 weeks across 5 people"; "Rebalanced 6 tasks… after-hours −38%" (sample, home) | #12 |
| Engagement Radar and attrition early warning (Adv) | The resignation nobody saw coming | Notice period plus rehiring cost | Activity drop and engagement drift, flagged weeks ahead | "Priya — activity down 35% in 2 weeks · attrition early-warning" (sample, hrms); "ATTRITION SIGNALS 3 wks Earlier than exit interviews" (benchmark, hrms); "92% Of burnout and attrition risks surfaced before… a resignation letter" (benchmark, home) | #10 |
| Leave Patterns (Adv, HRMS) | Leave every 7th working day, Monday absences, leave just before deadlines | Deadlines slip. Managers grow suspicious | The rhythm is flagged with a suggested kind step: check workload first, then a 1:1 | "Leave requests: every 7th working day"; blog: when the pattern appears, "After-hours 78%, Meeting creep 64%, Reply-lag drift 52%" | #13, #72 |
| Anomaly Feed (Adv) | Leave rhythms, reply-lag spikes and silent overtime, seen months late | Problems found after the damage | Flags each pattern the day it starts, with one-click actions | "surfaced the day they start" (home); "Patterns / week 120+" (benchmark, pattern-intelligence) | #12, #13, #16 |
| Workload imbalance and Load Balancer (skill) | Three people carrying most of the work while others sit under-used | example: two new hires at ₹6 lakh CTC = ₹12 lakh a year, when the capacity already exists (idea 22) | Every morning, real capacity is matched to demand and a rebalance is proposed | "3 people carried 70% of Green Soul while 4 teammates sat under 40% utilised"; "load 70% → 48%" (sample, home); "Engineering is at 1.6× the company baseline" (sample) | #11, #22 |
| Isolation and silo alerts (Adv, Org Intelligence) | A remote or night-shift person who has dropped out of the flow. Teams that have stopped working together | Resignations, and handoffs that fall between teams | Collaboration frequency flagged early | "QA has had no cross-team contact with Product for 11 days" (remote); "One night-shift agent has had no peer contact for 9 days" (support); "Ops and Sales haven't exchanged work in 3 weeks" (home) | #70, #78 |
| Manager 1:1 gap (plan?) | Managers who have not met their reports | Disengagement seen too late | Tracks how well each manager stays connected to the team | "Two engineers in Lisbon are 3 weeks past their last 1:1" (sample, remote) | new |
| Team Management: roles, permissions, org chart (plan?; SSO, roles and audit log are Ent) | Org charts in five spreadsheets. Managers seeing data they should not | Admin time, and privacy risk | One record per person. Owner, Admin, Manager and Member each get the right view. A manager is limited to their own reporting line | "Owner All / Admin Org / Manager Team / Member Self"; "Admin controls 4" (team-management) | new |
| Onboarding and offboarding checklists, access review (Adv, HRMS) | New joiners waiting on access. Leavers who keep their accounts | Lost first weeks, and a security gap | Checklists, a buddy, and quarterly role review | "onboarding 80% complete · buddy assigned"; "Quarterly role review completed — 0 orphan accounts" (sample, hrms) | #34, new (access review) |
| Ramp-up tracking (plan?) | New staff or contractors who take weeks to reach full output | site: "Access requests add 2.4 days to every start" (sample). example: at ₹5,000 a day for a contractor = ₹12,000 lost per start | The real ramp curve, with blockers named | "full output in 9 days against a 21-day average" (contract); "11 days, against a 17-day baseline" (bpo); benchmarks: "40% faster" ramp (contract), "35% faster recovery" (bpo) | #34 (partly), new |
| Single-owner knowledge (plan?) | The one person who knows a system. The contractor leaving with context | A scramble at handover | Areas with a single owner are flagged before the end date, with a handover plan | "Two areas have a single contract owner… No internal engineer has touched either in 60 days" (sample); "−35% knowledge gaps" (benchmark, contract) | #33 |
| Performance trends for 1:1s and appraisals (Std) | Appraisals decided on memory and on the loudest voice | Good quiet people leave | 12 weeks of trend and the reason behind it. The person sees the same data | "Data-backed 1:1s instead of gut feel" (productivity-scoring) | #15, #35, #65, #67 |
| Recruiter desk health (plan?, HR and staffing) | Recruiters busy with admin instead of sourcing. One recruiter carrying six clients | site: "Admin is eating 28% of the week" (sample) | Links work patterns to placements. The habits of the best recruiters become a playbook | "one recruiter fills in 19 days and another takes 41"; "Top two recruiters run 90 minutes of uninterrupted sourcing before 11am"; benchmarks: "28%" faster placements, "35%" more per recruiter, "40%" lower turnover | #88 |

## 6. Projects and clients

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Project Tracking dashboard (plan?) | Status meetings where everyone says "80%" | Meeting hours, and false comfort | Hours and headcount per project, updated live. Projects at risk are marked | "Seller7 has run 50h 29m across 19 people this month"; "24 projects" (sample) | #31, #27 |
| Time distribution and budget vs actuals (plan?) | Budgets that overrun without anyone noticing | site: "Payments v2 has burned 538h of 640 with 290h of scope left… Projected 828h". example: 188h over budget × ₹1,000 an hour = ₹1.88 lakh | Planned hours compared with hours spent, kept current. Overrun shown in hours and cost | "Budget overruns −32% Caught in week four instead of at invoicing" (benchmark, project-based) | #31, #86 |
| Deadline risk / slip alerts (plan?) | Every report says green, then the project is three weeks late | Late delivery and an angry client | Risk scored from real hours spent, stalled stages and review queues | "Projected 19 days late"; "flagged three weeks before the date" (sample); "+35% on-time delivery" (benchmark) | #31, #40 |
| Team allocation / over-allocation (plan?) | A specialist booked on four projects. Bench time nobody sees | Burnout on one side, idle salary on the other | Real hours per person per project | "Priya is booked at 118% across four projects" (sample); "Only 2 members and 4h 33m… against a 60% completion target" (sample, project-tracking); "+28% resource utilization" (benchmark) | #22, #27 |
| Bottlenecks, handoffs and dependencies (Adv, Org Intelligence) | Work waiting between two desks, and the same blocker over and over | site: "Adding a second review slot recovers roughly 9 days of calendar" (sample) | Time spent at each stage, and which dependency causes the wait | "Work waits 4.6 days in security review, up from 1.9"; "Design → Engineering hand-offs wait 2.4 days"; "Code reviews now wait 9h — up from 4h" (samples) | #9, #23, #76 |
| Client profitability / effective rate (plan?) | The client who costs more than they pay | site: "Retainer covers 40h. Team logged 64h, and 58% of it was reactive" (sample). example: 24 unpaid hours × ₹1,000 = ₹24,000 a month absorbed | Hours set against the fee for each account, with the effective hourly rate kept current | "Effective rate: Northwind $186… Halcyon Group $72"; "Ridge Foods −9%" margin (samples); "+15% client margins" (accounting), "+32% client margin" (client-driven) (benchmarks) | #3, #86 |
| Scope creep watch (plan?) | Extra rounds of revisions on a fixed fee | Margin lost quietly | Scope creep shown while it is still small, so renewal pricing can be based on effort | "Renewal pricing based on effort, not assumptions" (accounting) | #3, #86 |
| Rushed-review quality flag (plan?, accounting) | Long prep sessions followed by a rushed review just before filing | Errors in a filing, and professional risk | Flags the job for a senior review | "9.4h of prep in one sitting and 18 minutes of review. Firm average… 2.1h" (sample) | new |
| Seasonal load forecast (plan?) | The tax-season or back-to-school spike, staffed on instinct | Overtime, backlog, missed deadlines | Last year's data projects the peak, so staffing is set early | "Filing volume peaks week of Mar 24, 38% above baseline"; "Two seniors past 52h for three straight weeks" (accounting); "Ticket queue grew 3.4× in nine days. First response is now 19 hours" (edtech); benchmarks: "−38% peak-season overtime", "42%" better planning | #44 (accounting only), new |
| Goals & Tasks (Std) | A goal with no owner. A deadline slip heard on the due date | Missed quarter goals | Progress read from the work itself, not from check-ins | "68% of Q3 goals · 5 weeks left"; "Migrate billing — No owner"; "Onboarding revamp — Slipped 2×" (sample, home interactive) | #40 |
| SLA tracking (plan?, ops and support) | SLA breaches found in the month-end report | Penalties and churn | Breach risk flagged hours ahead, per queue and shift | "Billing queue 61%" (sample); "+40% SLA compliance" (benchmark, support) | #75 |
| Quality consistency (plan?, support) | The same issue takes 12 minutes for one agent and 2.6 hours for another | Uneven service that customers feel | Handling compared on like-for-like issues, so coaching targets the slow step | "Billing refunds range 12m to 2.6h"; "−35% quality variation" (benchmark) | #74 |
| Shift handovers (plan?) | Work left unowned between shifts | site: "4.5h gap. 12 cases sat unowned" (sample) | Time to first touch after each handover, plus a suggested overlap window | "APAC to EMEA handovers dropped to 78% documented"; "28% faster cross-timezone completion" (benchmark, bpo) | #77 |
| Product vs support time (plan?, edtech) | Engineers pulled into support so the roadmap stalls | site: "Engineering spent 44% of the sprint on escalations. Two features moved" (sample) | Engineering time measured instead of estimated | "Roadmap 41% / Support escalation 33%" (sample); "28% faster" feature shipping (benchmark) | new |
| Customer-success load per account (plan?, edtech) | One account eating the CS team | Churn risk at renewal | CS load per account and per person | "One account is taking a third of CS capacity. It is also the one renewing in November" (sample) | new |
| Contractor value benchmark (plan?) | "Was that rate worth paying?" | Renewing a weak contractor, or losing a strong one | Contract and internal work on one scale, and cost per delivered unit of work | "Output per engaged hour: Contractor A 1.18x, Contractor B 0.72x" (sample); "−18% contingent spend", "+25% contractor ROI" (benchmarks) | #32 (partly), new |
| Recruitment pipeline stage timing (plan?) | Candidates stuck in a stage for weeks | Slow time-to-fill | Days per stage. Client-side and recruiter-side delays shown apart | "Submitted 12d"; "Time-to-fill 24d, Sub → interview 54%, Offer accept 81%" (sample) | #88 (partly), new |

## 7. Sales, CRM and email

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Self-writing CRM (Adv) | The CRM nobody updates | A pipeline nobody trusts | Calls, emails and touches are captured from real activity, and cards move on their own | "MANUAL LOGGING 0"; "Reps sell; the CRM writes itself" (crm) | #17 |
| Lead-lag alerts (Adv) | Leads logged hours late, or never called back | A lead that "shops elsewhere" | Times every step: arrival to entry, entry to first touch, touch to reply | "New leads logged 6h late on average this week" (sample); "FIRST TOUCH <2h" (crm) | #39 |
| Quiet-deal alerts (Adv) | A deal nobody has touched in days | site: "Orbitline — no touch in 5 days on a ₹3.1L deal" (sample) | An alert after a threshold you set, sent to the right owner | "QUIET DEALS −64%" (benchmark, crm); "₹42L in open deals · 9 with no next step" (sample, home interactive) | #55 |
| Winning rhythm / pipeline patterns (Adv) | Nobody knows what actually closes deals | Lost deals | Won deals are read to find the rhythm, and every new lead is nudged onto it | "first touch within 2 hours, a demo inside 4 days, and follow-ups every 48 hours. Deals that died averaged a 3-day first touch" (sample) | #56 |
| Per-rep coaching cards and effort-to-deal-size view (Adv) | Big effort on small deals, and coaching done by league table | Rep time spent in the wrong place | Coaching cards per rep, not rankings | "Per-rep coaching cards, not league tables"; "Effort-to-deal-size balance view" (crm) | new |
| CRM import and migration (Adv) | Fear of moving off Excel or another CRM | Switching effort | CSV import. The team migrates on request | "CSV import takes minutes" (crm) | new |
| Email Insights: reply-lag radar (Adv) | Client emails waiting days. Slow replies are an early sign a client is leaving | site: "Acme Logistics 4.2d" waiting (sample) | Reply lag by team, person, account and client, from Gmail metadata only | "STALE THREADS −80% Typical drop in 48h+ client emails within a month" (benchmark); "REPLY TARGET <2h"; "Setup 1 click" (email-insights) | #16 |
| Revenue-weighted queue and auto-nudges (Adv) | Replies handled in inbox order, not by value | Big accounts left waiting | Threads sorted by revenue at risk, and owners nudged automatically | "42 client emails waiting 48h+ · owners nudged automatically" (sample) | #16 (partly), new |
| Comms Health score (Adv) | Who is drowning in email, who is flowing, and who is being ignored | Overload and missed replies | A health score per team | "82/100 Comms health score" (sample); "Accounts 9.1h" reply lag (sample) | new |
| Reply SLA Keeper (skill) | Client mail stuck with one owner or with someone on leave | A deal goes cold | Escalates before a deal goes cold, and re-routes threads away from an owner on leave | "Nudged 4 owners… queue cleared"; "Re-routed 7 threads from an owner on leave"; "reply time −67%" (sample, home) | #16, #39 |
| Lead Routing Skill (shown as "LEARNING") | New leads sitting unassigned | site: "New leads sat 6 hours on average" (sample) | Sends each lead to the first free rep | "first touch −98%" (sample; still learning) | #39 |
| Response time per account (plan?, client-driven) | Service promises nobody measures | Client satisfaction | Response time per account, not per inbox | "Median first reply 34 min" (sample); "+28% client satisfaction" (benchmark) | #16 |

## 8. AI tool adoption

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| AI Tool Radar (plan?) | Paid AI seats (ChatGPT, Copilot, Cursor) that most of the team never opens | example: 30 seats × ₹2,000 a month = ₹60,000 a month, whatever the usage | Shows who uses AI tools and how much of the day. Never shows what they typed | Named only in the home module list ("AI Tool Radar"). No page explains it | #2, #62 |
| AI tools as an app category (Std) | AI time hidden inside "Chrome" | none | AI tools appear as their own line in app time | "AI tools 1.2h" of the day (sample, monitoring and employee-monitoring-software) | #63 |
| Unapproved AI tools flag (plan?) | Staff putting company work into personal AI accounts | Data risk | Unapproved AI tools flagged in app tracking | "6 unapproved AI tools · Design · 0.8h" (sample, home interactive) | new |
| AI adoption per person, in the product (plan?) | Uneven AI use across the team | Training money with no visible change | In the app: "X of N people using AI", which tools, and the share of the day. It detects Cursor, ChatGPT, Claude, Gemini, Copilot, Perplexity, Windsurf and Grok. AI adoption is also a section of the CEO / Executive Brief template | App code only, not on a public page. Verify before quoting | #2, #62, new detail |
| AI adoption benchmark (report teaser) | "Are we behind on AI?" | none | none | "Focus is up, meetings are worse, and AI adoption is wildly uneven" (blog, State of the SMB Workday 2026 teaser). No figure is published | new |

## 9. Ask TeamGrid and Pattern Intelligence

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Ask TeamGrid (Adv) | Digging through dashboards, and ten "update?" messages | Founder and analyst time | Plain-English questions answered from live data. Follow-up questions keep the context, and answers name the people and hours behind them | "TEAMGRID ANSWERED — 4 SECONDS" (sample); "1.4s median answer" (home interactive); "Answers Live" (ask-teamgrid) | #24, #79 |
| Answers with a recommendation and a downloadable report (Adv) | A number that starts an argument instead of a fix | Meetings spent on the dispute | Names the pattern and the next step, then hands back a one-page report | "Move review to a daily slot and Billing lands Thursday"; "Download as a one-page report" (compare pages) | #79 |
| Org Intelligence: strengths, issues, recommendations (Adv) | Problems found only by sending surveys or holding retros | Time lost before anyone knows where to look | Each month: strengths, issues and actions per team, each with an expected gain | "Strengths 5, Issues 4, Actions 3"; "Design has shipped 2 days early for three sprints" (sample) | #9, #21 |
| Forecasting (Adv) | Load spikes that arrive with no warning | Backlog | Where productivity or load is heading | "Support load trending +12% into next week" (sample, org-intelligence) | new |
| Org Graph (Adv) | Who work actually passes through, and which person or team is overloaded | A bottleneck that stays hidden | A living map of teams, handoffs and load | "5 teams mapped · 38 hand-offs traced this week" (sample, home interactive) | #33, #66, #23 |
| Org Memory (Adv) | A new manager spends a month learning how the team works | Lost month | TeamGrid remembers how the company works | "LEARNED: Design does deep work before noon" (sample, home) | #68 |
| Skill Library (Adv) | Repeated manual chores nobody has automated | Hours every week | Any pattern can become a named skill that watches one area and acts on its own | "6 skills · 4 active" for a 120-person team (sample, home) | #42 |
| Deep Search (Adv) | Hard "why" questions | Analyst days | Checks activity, email lag, attendance and the org graph together | "Why did support slow down in May?" → "+18% tickets · same headcount… 2 senior agents on planned leave" (sample, pattern-intelligence) | #79 |
| Pattern AI, several AI models (Adv) | none | none | "The right model for every question. One subscription"; GPT, Claude and Gemini are named (home) | Also on home: "Zero data training & retention agreements are in place with every model provider" | new |
| Speed to first insight | "How long before we see anything?" | none | Patterns start within a day | "FIRST PATTERN 24h" (pattern-intelligence); "Within 24 hours the brain starts mapping focus, load, rhythms and risks" (home); "STATUS MEETINGS −38%" (benchmark) | #83 |

## 10. Pricing and setup

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| Standard plan | Several separate tools for tracking, timesheets and reports | example: 50 seats × ₹299 = ₹14,950 a month | Productivity scoring and hourly breakdown, app and website tracking, attendance and auto timesheets, daily AI summaries, goals and tasks | "₹299 / user / mo billed monthly" (pricing) | #4, #52 |
| Advanced plan | A separate CRM, HRMS and email tracker | example: 50 seats × ₹649 = ₹32,450 a month | Everything in Standard plus Ask TeamGrid and Pattern Intelligence, Anomaly Feed and early warnings, Email Insights, CRM, HRMS, and the weekly Founder's Report | "₹649 / user / mo… MOST POPULAR" (pricing) | #4 |
| Enterprise plan | Compliance and control needs | none | On-site data residency, SSO, roles and audit log, a dedicated success manager, custom integrations and API | "Custom · Volume pricing · annual billing" (pricing) | #48 |
| Same rate on every term | Fear of being locked in to get a discount | none | Monthly, 3, 6 and 12 months all cost the same per user | "Same per-user rate on every term — pay for a month at a time, no lock-in premium" (pricing) | new |
| Free trial | Fear of a card on file and a surprise bill | none | 7 days, no credit card. The workspace pauses at the end and data stays exportable | "7-day free trial on every plan · no credit card · cancel anytime"; "data stays exportable for 30 days and nothing is ever auto-charged" (pricing) | #80 |
| Mix plans across teams | An all-or-nothing roll-out decision | none | Standard for some departments, Advanced where it is needed | "Can we mix plans across teams? Yes" (pricing) | #81 |
| 5-minute install, 10 to 10,000 machines | No IT department. Large fleets | example: none | One agent for macOS, Windows and Linux. A guide for mass roll-out through device-management (MDM) tools | "Install in minutes. One agent, 10 or 10,000 computers"; "Live in 5 minutes"; "Single machines to 10,000-seat MDM rollouts in one policy" (help) | #47, new (fleet roll-out) |
| Rupee billing | Dollar card charges | none | INR or USD billing, with invoices | "Trials, upgrades, INR/USD billing and invoices" (help). GST is not mentioned | #84 (GST still verify) |
| Support | Worry that nobody will help | none | 24/7 human support | "Humans, 24/7, median 4 minutes" (help); "24/7 SUPPORT" badge | new |
| Price vs trackers | Paying in dollars for a tracker with no AI | none | Compare table (Time Doctor, Hubstaff, ActivTrak, Insightful) | compare hub: "₹299" vs "$6.70 / $4.99 / $10 / $6.40 USD". On the Time Doctor page today: TeamGrid "$6.99" vs Time Doctor "$6.70" | #4 (partly) |
| Managed Services: free 30-minute audit (separate service) | Nobody knows where automation or AI pays off | site calculator: 87 people at ₹30K with 9 automatable hours a week = "₹9.6L wasted every month… ₹1.2Cr/year"; "666h recoverable hours/week" | Analysts map 3–5 leaks with costs, then build the fix inside your systems | "14 Organisations · ₹12Cr+ Revenue saved · 100+ Workflows built" (resource-optimizer) | #60, #61 |
| Managed Services: built systems (Gujarat case) | Manual reporting, chasing invoices, entering the same data twice, dealer follow-ups | site: "60% of their time on manual reporting…"; "127h manual → 11h"; "₹22L/mo → ₹4L/mo"; "₹10L/month in savings" | Invoice Tracker, Report Generator, CRM Auto-Sync, Email Follow-up Bot, Meeting Summarizer, Inventory Alerts | "overdue invoices −94%"; "12 seconds instead of 6 hours"; "15h/week" data entry removed; "Response rate up 34%"; "Predicts stockouts two weeks ahead" | #20, #26, #57, #58, #59; new (Meeting Summarizer, Inventory Alerts) |

## 11. Privacy

| Capability | What it catches | What that problem costs a client | What TeamGrid gives instead | Exact numbers/claims on the site | In idea bank? |
|---|---|---|---|---|---|
| No screenshots, keystrokes, camera or clipboard | Staff pushback against spy tools, and bad employer reviews | Attrition, and a failed roll-out | Only the shape of work is measured | "No screenshots. No keystrokes. Ever."; "Not an optional setting. The capability does not exist" (compare-insightful); "Keystrokes, clipboard or camera" never touched (security) | #19, #38 |
| Email metadata only | "Will you read our mail?" | none | Only timestamps, thread counts, reply intervals and internal/external flags. Personal threads are excluded automatically. Access can be revoked with one click | "Subject lines, bodies and attachments are never accessed" (pricing); "EMAIL BODIES READ 0" (email-insights); Google Workspace only, "Microsoft 365 is on the roadmap" | #19 |
| Work sessions only | Tracking during breaks or personal time | none | Captures only during an active tracking session | "Breaks, personal time and anything outside work hours are never touched" (compare-activtrak); "Personal apps & browsing outside work profile" never touched (security) | #19 |
| Employees see their own data | "Is this spying?" | none | Everyone sees their own score, summary, attendance and timesheets first | "Every employee sees their own attendance, patterns and timesheets" (hrms); "People see their own summary before anyone else" | #38, #67, #73 |
| Own-baseline comparison, team level first | Unfair rankings, and night owls marked down | none | Each person is compared with their own history and team. Person-level detail follows consent rules | "Baseline-relative, so night owls aren't punished"; "Team-level first; person-level with consent rules" (monitoring) | #15 |
| Security certifications | Security questionnaires from larger clients | Deals stalled in procurement | Badges plus a report on request | "SOC 2 TYPE II · ISO 27001 · GDPR · HIPAA · ON-SITE DATA RESIDENCY" (home, security); "SOC 2 report available on request" (pricing) | #48, #87 |
| Encryption and access control | Data leaks | none | TLS 1.3 in transit, AES-256 at rest, automatic key rotation. SSO and SCIM, and an audit log | security page; annual penetration tests and a responsible-disclosure programme | new |
| Retention control and data location | Where the data sits and for how long | none | You set the deletion clock. Regional hosting, or on-site residency on Enterprise | "Raw signal aggregates fast; you set the deletion clock" (security) | #48 |
| AI without training on client data | "Will our data train someone's model?" | none | Agreements with every model provider | "Zero training & retention agreements with every model provider" (security, home) | new |

---

## Numbers we may quote

**Safe: product facts.**
- ₹299 / user / month Standard; ₹649 Advanced; Enterprise custom (pricing).
- Same rate on monthly, 3, 6 and 12-month terms (pricing).
- 7-day free trial, no credit card, nothing auto-charged, data exportable for 30 days (pricing).
- Setup in 5 minutes, one agent for 10 or 10,000 computers (home, features).
- macOS, Windows and Linux; background agent of 3 MB; offline mode (download).
- First pattern within 24 hours (home, pattern-intelligence).
- Daily summary by 6 PM; Founder's Report on Monday at 9 AM (ai-work-summaries, pattern-intelligence).
- Email Insights uses metadata only and works with Google Workspace (email-insights).
- Productivity score from 4 signals, with 12 weeks of history (productivity-scoring).
- 24/7 support; INR or USD billing (help).

**Sample-screen numbers.** Use these only as "for example" and say they are illustrations.
- 85% hour vs 40% hour (hourly-breakdown).
- Ops 41% of the week in meetings (home).
- 3× after-hours baseline (home).
- Leave every 7th working day (home, hrms).
- 42 client emails waiting 48h+ (email-insights).
- Lead logged 6h late; ₹3.1L deal quiet for 5 days (crm).
- Won deals: first touch within 2 hours, demo inside 4 days, follow-ups every 48 hours (crm).
- Retainer covers 40h, team logged 64h (client-driven).
- 1.4h unlogged today, 4.8h this week (accounting).
- Monday −23%; standup moved to 9:30 AM; about 4 hours a week recovered (org-intelligence).
- Design → Engineering handoffs wait 2.4 days (compare-hubstaff, home).
- 3 people carry 70% of a project (home).
- 118% booked across four projects (project-based).
- Refunds taking 12 minutes to 2.6 hours (virtual-support).
- Night-shift agent with no peer contact for 9 days (virtual-support).

**Benchmarks.** Quote these only as "TeamGrid reports…", with the page named, and only after the product team confirms them (IN3). The site's own footnote says "Aggregated, anonymized TeamGrid workspace benchmarks, 2026".
- Monitoring: meeting load −22%.
- Email Insights: stale 48h+ threads −80% within a month; reply target under 2h.
- CRM: quiet deals −64%.
- Pattern Intelligence: status meetings −38%; 120+ patterns a week.
- HRMS: attrition signals 3 weeks earlier than exit interviews.
- Accounting: +22% billable utilization, +12% revenue realization, −38% peak-season overtime, +15% client margins.
- Project-based: +35% on-time delivery, −32% budget overruns ("caught in week four instead of at invoicing").
- Client-driven: +40% proactive hours, +28% client satisfaction.
- BPO: 28% faster handoffs.
- Virtual support: −35% quality variation.
- Blog report teaser: "41% of the average Ops week is meetings".
- Blog leave-rhythm article: after-hours 78%, meeting creep 64%, reply-lag drift 52%.
- Managed Services, Gujarat case: 127h → 11h manual work a week; ₹10L a month saved; weekly ops report in 12 seconds instead of 6 hours; overdue invoices −94%. Use these only in audit mails.

## Claims to avoid

**Banned list: does the site use them?**
- **Guaranteed ROI.** The word "guaranteed" is not used. The site does make payback claims: "Pricing that pays for itself", "PAYBACK <1 mo", "One cancelled status meeting covers the whole seat" (home, pricing), and "Make every contract pay for itself" (contract). Treat all of these as the banned ROI claim.
- **10x productivity.** Not used anywhere.
- **Used by 500+ teams.** Used: home ("500+ active teams", "across 500+ companies", "+495 more teams"), about ("500+ companies"), and blog ("500+ companies' anonymized patterns"). It conflicts with "5,000+ companies" on /time-tracking-software and /employee-monitoring-software.
- **+32% focus.** Used on home: "+32% Average lift in deep-focus hours after eight weeks". The same figure also appears as unrelated benchmarks: "+32% client margin" (client-driven) and "32% client NPS" (HR).
- **6.2 hours saved.** Used on home and pricing: "6.2h saved per manager, per week". It also appears as sample numbers: "+6.2 pts" (productivity-scoring) and "6.2h focus yesterday" (home). Do not quote any of them.
- **We never store any data.** Not used, and it would be false. The site says raw data is aggregated and the client sets the deletion clock, and that data stays exportable for 30 days. Only these narrow claims are safe: page contents, email bodies, screenshots and keystrokes are never captured.

**Unverified or contradictory. Do not use.**
- **Size claims.** "12M+ work hours analysed" (home) conflicts with "3M+" (pricing, about, banner). "4.8/5 from 210+ reviews on G2, Gartner and Product Hunt" and "92% of burnout risks surfaced" are unverified.
- **Testimonials.** Ananya Sharma, Rahul Mehta and Priya Nair are the same names used on the sample screens. Jay Mistry, Rupesh Sanghavi, and Avnish Gevariya (CMO, BrandGrid) look like people from our own circle. The quote "development velocity by 40%" is unverified.
- **"End to end" encryption.** The automatic-time-tracking page says "E2E". The security page describes TLS 1.3 plus AES-256, which is not end-to-end encryption.
- **Where the data goes.** Ask TeamGrid says "Nothing leaves your workspace to answer a question", but home says "every frontier model reads your org's full context" (GPT, Claude, Gemini). Say only "zero training and retention agreements with model providers".
- **Scoring.** The ActivTrak page says "No behavior scores… Nobody gets ranked" and "ACTIVITY SCORES 0". The product has per-person productivity scores, and Ask TeamGrid lists "top performers". Do not claim "no scores" or "no ranking".
- **CRM and HRMS price.** The compare hub says CRM and HRMS come "in the same seat price". They are only in Advanced at ₹649, never at ₹299 (IN7).
- **"Cheaper than" competitors.** The Time Doctor page now shows TeamGrid at $6.99 against Time Doctor's $6.70. Also avoid "roughly a third off" ActivTrak.
- **Operations page claims.** "20–30% efficiency gains in the first month", "measurable improvement within the first two weeks", "SLA 99.9%", "connects with 100+ operational tools" (home says 14 sources), and "−50% errors".
- **Compare-page claims.** "45% faster decisions" and "5× faster time to insight" are self-reported.
- **Features that are not live yet.** Lead Routing is marked "LEARNING" and Focus Protector "SUGGESTED". Do not present either as live. A mobile app, Slack delivery and Microsoft 365 email insights are either only listed or on the roadmap. HIPAA, ISO 27001 and India data residency are badges only, so verify them (#48, #87).
- **Managed Services wording.** The case says "Our software silently tracked 2,847 unique workflow patterns" and "Deployed monitoring agents". This clashes with "patterns, not people", so do not quote it. "14 organisations, ₹12Cr+ revenue saved" is unverified.
- **The State of the SMB Workday 2026 report.** Only a teaser exists, and the banner links to a different article. Do not promise the report or link to it as a report.
- **App-code features.** The report templates "Red Flags / Conduct Review" and "Idle Time & Reasons Review" exist in the app code. Never use them in mails, because they read as surveillance.
- **Every segment benchmark.** For example, "SLA compliance +40%" and "Recruiter output 35%". Each carries only the site's own footnote. Treat them as unverified until IN3 is done.

## Capabilities not yet in the idea bank

1. Desktop App vs Background Agent, with offline mode ("0 lost") and idle auto-pause.
2. Weekday pattern with a specific recommendation (Monday −23%, move the standup to 9:30 AM, about 4 hours a week).
3. Idle vs waiting vs rework split per stage (operations: 36 cases touched more than twice because of one form field).
4. Reactive vs proactive work split (client-driven: proactive 38% → 58%).
5. Timezone overlap window and async response time (remote teams).
6. Productivity benchmarked across sites and shifts (BPO: one site 16 points behind because of approval queue design).
7. Monthly reports, and the "stalled work" watch-item (a task picked up and dropped for four weeks).
8. Team briefs by function (Friday pipeline brief, support digest, ops weekly, monthly people review).
9. Report templates: CEO Brief, Per-Client / Practice, Accounts & Finance Review. These are in app code only, so verify.
10. Manager 1:1 gap alert.
11. Team Management: role-scoped views, where a manager sees only their own team.
12. Quarterly access review ("0 orphan accounts").
13. Ramp-up curve for new staff and contractors ("access requests add 2.4 days to every start").
14. Rushed-review quality flag (accounting: 9.4h of prep, 18 minutes of review).
15. Seasonal load forecast outside tax season (edtech back-to-school; forecasting in Org Intelligence).
16. Product vs support engineering time (44% of the sprint on escalations).
17. Customer-success load per account (one account taking a third of CS capacity before its renewal).
18. Contractor value benchmark (output per engaged hour, 1.18x vs 0.72x).
19. Recruitment pipeline stage timing (Submitted stage 12 days).
20. CRM per-rep coaching cards and the effort-to-deal-size view.
21. CRM CSV import and migration help.
22. Revenue-weighted email queue with auto-nudges.
23. Comms Health score (82/100).
24. Unapproved AI tools flag ("6 unapproved AI tools").
25. AI adoption per person ("X of N people using AI", eight named tools). App code only, so verify.
26. AI adoption as a benchmark topic ("AI adoption is wildly uneven", report teaser).
27. Pattern AI: several models, with zero-training agreements.
28. Load forecasting ("support load trending +12% into next week").
29. Same price on every term, with no lock-in premium.
30. Roll-out to 10,000 machines through device-management (MDM) tools.
31. 24/7 human support, median 4 minutes.
32. Security detail: TLS 1.3, AES-256, SCIM, audit log, pen tests, client-set retention.
33. Managed Services builds not yet used: Meeting Summarizer and Inventory Alerts ("predicts stockouts two weeks ahead").
