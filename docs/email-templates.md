# TeamGrid email templates

Two tracks. Track A is for a lead who clicked an ad or filled a form and has no account.
Track B is for a person who signed up. Every mail is one idea, one ask, signed by the team, and
replies land in a mailbox a person reads. A reply stops the sequence. A signup moves the
person from A to B. A step already done is skipped, not mailed about.

Sender on both tracks: `TeamGrid`, from the sending mailbox; replies land in that mailbox and a person reads them. No individual's name appears anywhere, and the lead's company name is never printed.

Variables the engine already has: `first_name`, `company`, `person_id`, `trial_link`,
`opt_out_url`. Variables the engine still needs: `team_size`, `install_link`,
`invite_link`, `report_link`, `trial_end_day`, and the product events `session_recorded`,
`teammate_invited`, `report_viewed`.

Gaps between mails are deliberately uneven (2, 4, 4, 5 days). Even gaps read as automation.

---

## Track A: ad lead, no account. Plain text.

### A1. Sent within 5 minutes of the form

Subject: `quick one about your team's week`
Preview: `you clicked our ad. 60-second version, then I go away`

```
Hi {{first_name}},

You clicked our ad about where a team's time goes. Here is the 60-second version so
you do not have to dig.

TeamGrid puts one small app on each computer. Every morning it writes you a plain
summary: which projects took the day, who is overloaded, which meetings nobody needed.
No timesheets. No screenshots, no keystrokes, ever.

Free for 7 days, no card: {{trial_link}}

If it is not for your team, reply "no" and we stop. If it might be, reply with your
team size and we will tell you honestly whether it fits.

The TeamGrid team
```

### A2. Day 2, only if A1 was not clicked

Subject: `is TeamGrid monitoring?`
Preview: `straight answer, and what it does see`

```
Hi {{first_name}},

The question we get most from people who clicked that ad: is this employee monitoring?

Short answer: no screenshots, no keystrokes, no reading anyone's email. It sees which
apps are open and for how long, calendar load, and how long emails wait for a reply.
From that it finds patterns, like meeting load up 40% in Ops since March. Your team
sees the same view you do.

If that was the line you needed to see before trying it: {{trial_link}}

The TeamGrid team
```

### A3. Day 6, only if a link was clicked and no account exists

Subject: `what Monday morning looks like`
Preview: `one screenshot, no pitch`

```
Hi {{first_name}},

You had a look at TeamGrid last week and stopped, which usually means "fine, but what
do I actually get?"

This is it:

[image: Today's story block from the dashboard, four AI-written lines about yesterday]

Four lines about yesterday, written before you sit down. Nobody typed a status update.

Two teammates on the app for three days gets you your first one: {{trial_link}}

The TeamGrid team
```

### A4. Day 10, if still no account

Subject: `four tools, one price`
Preview: `tracker, HRMS, CRM, timesheets. one app, one seat price`

```
Hi {{first_name}},

Most teams your size run three or four tools for this: a time tracker, an HRMS for
attendance, a CRM, and a spreadsheet for timesheets.

TeamGrid has all of it under one agent, with an AI you can ask plain questions: why did
sales slow down, who is overloaded, what changed since Monday.

One seat price, 7-day trial, no card: {{trial_link}}

The TeamGrid team
```

### A5. Day 15, last

Subject: `last one from us`
Preview: `if it's not useful, that's a fair answer`

```
Hi {{first_name}},

Last note. If TeamGrid is not useful for your team, that is a fair answer and this is
the end of it.

If timing was the problem, reply "later" and we will check back once, in three months.

The TeamGrid team
```

Off-ICP leads (no team, wrong industry) receive A1 only.

---

## Track B: signed up. Light HTML: logo, one screenshot, one button.

### B1. Sent within 5 minutes of account creation

Subject: `you're in. one step left`
Preview: `install the app, 5 minutes, first report tomorrow`

```
Hi {{first_name}},

You're in. One step left before TeamGrid can show you anything: install the small app
on your computer.

[image: the download page, Mac / Windows / Linux]
[button: Install the TeamGrid app] -> {{install_link}}

Five minutes. Tomorrow morning you get your first daily summary. Invite one teammate
from the Team page and the summary gets useful fast.

It never takes screenshots or records what you type. Only which apps are open, and for
how long.

Reply if you get stuck. a person reads every one.

The TeamGrid team
```

### B2. Two hours after B1, only if `session_recorded` is still false

Subject: `stuck on the install?`
Preview: `2-minute fix, or reply "help" and we do it with you`

```
Hi {{first_name}},

The app is not reporting from your computer yet. That step trips people up more than
it should, so here is the short version:

Mac: open the .dmg, drag TeamGrid to Applications, allow it once under Privacy &
Security.
Windows: run the installer, click Yes on the one prompt.

[button: Download again] -> {{install_link}}

Or reply "help" with your operating system and we set it up together on a ten-minute
call. No sales on it, just the install.

The TeamGrid team
```

### B3. One day after the first session, only if `teammate_invited` is false

Subject: `one teammate makes it real`
Preview: `tomorrow's report is about you only. add one person`

```
Hi {{first_name}},

Your app is reporting. Tomorrow's summary will be about you alone, which is a bit dull.

Invite one teammate and the same summary shows where two people's hours went, side by
side. That is the moment most owners spot the first thing they did not know.

[button: Invite a teammate] -> {{invite_link}}

The TeamGrid team
```

### B4. Three days of data, only if `report_viewed` is false

Subject: `your first report is ready`
Preview: `three days of data. 90 seconds to read`

```
Hi {{first_name}},

Three days in, your first Work Picture is ready: hours by person, by project, meetings,
and the app mix.

[image: the dashboard, Work Picture block]
[button: Open your report] -> {{report_link}}

Takes 90 seconds. Reply with the one thing that surprised you. we collect those.

The TeamGrid team
```

### B5. Two days before the trial ends

Subject: `your trial ends {{trial_end_day}}`
Preview: `keep it, pause it, or drop it. one click each`

```
Hi {{first_name}},

Your trial ends on {{trial_end_day}}. Three honest options:

Keep it: one seat price per person per month, cancel any time.
[button: Keep TeamGrid] -> {{trial_link}}

Not now: reply "pause" and we hold your data for 30 days.

Not for you: do nothing. It switches off, and your data is deleted in 30 days.

If something got in the way of seeing value, tell us what. We would rather fix it than
sell around it.

The TeamGrid team
```

### B6. Three days after the trial ended, only if not converted

Subject: `what got in the way?`
Preview: `one question, no pitch`

```
Hi {{first_name}},

Your trial ended and you did not continue. Fair enough.

One question, because the answer changes what we build: what got in the way?

Reply with a sentence. a person reads every one and I will not follow up after this.

The TeamGrid team
```

---

## Subject and preview rules used above

- Two to six words. Sentence case or lowercase. No first name in the subject.
- The preview extends the subject, never repeats it. Hook in the first 35 characters
  for mobile.
- No exclamation marks, no "newsletter", no "update", no emoji.
- One mail, one idea, one link. Every link in a mail goes to the same place.
