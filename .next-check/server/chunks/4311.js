"use strict";exports.id=4311,exports.ids=[4311],exports.modules={18121:(a,b,c)=>{c.d(b,{nW:()=>q,iS:()=>m,kO:()=>l,x8:()=>p,Gn:()=>o});var d=c(51420),e=c(38930);let f=[[0,59],[0,23],[1,31],[1,12],[0,6]];function g(a){let b=a.trim().split(/\s+/);if(5!==b.length)return null;let c=[];for(let a=0;a<5;a++){let d=function(a,[b,c]){let d=new Set;for(let e of a.split(",")){let a,f,[g,h]=e.split("/");if(void 0===g)return null;let i=void 0===h?1:Number.parseInt(h,10);if(!Number.isInteger(i)||i<1)return null;if("*"===g)a=b,f=c;else if(g.includes("-")){let[b,c]=g.split("-").map(a=>Number.parseInt(a,10));if(void 0===b||void 0===c||!Number.isInteger(b)||!Number.isInteger(c))return null;a=b,f=c}else{let b=Number.parseInt(g,10);if(!Number.isInteger(b))return null;a=b,f=void 0===h?b:c}if(a<b||f>c||a>f)return null;for(let b=a;b<=f;b+=i)d.add(b)}return d.size?d:null}(b[a],f[a]);if(!d)return null;c.push(d)}let[d,e,g,h,i]=c;return i.has(7)&&i.add(0),{minute:d,hour:e,dayOfMonth:g,month:h,dayOfWeek:i,everyDayOfMonth:"*"===b[2],everyDayOfWeek:"*"===b[4]}}function h(a,b=new Date){let c=g(a);if(!c)return null;let d=new Date(6e4*Math.floor(b.getTime()/6e4)+6e4);for(let a=0;a<400;a++){let e=new Date(d.getTime());if(a>0&&(e.setUTCDate(e.getUTCDate()+a),e.setUTCHours(0,0,0,0)),!c.month.has(e.getUTCMonth()+1))continue;let f=c.dayOfMonth.has(e.getUTCDate()),g=c.dayOfWeek.has(e.getUTCDay());if(!(c.everyDayOfMonth&&c.everyDayOfWeek||(c.everyDayOfMonth?g:c.everyDayOfWeek?f:f||g)))continue;let h=0===a?e.getUTCHours():0;for(let d=h;d<24;d++){if(!c.hour.has(d))continue;let f=0===a&&d===e.getUTCHours()?e.getUTCMinutes():0;for(let a=f;a<60;a++){if(!c.minute.has(a))continue;let f=new Date(e.getTime());if(f.setUTCHours(d,a,0,0),f>b)return f}}}return null}var i=c(98702),j=c(18962);let k={acquire:"0 * * * *",advance:"15 * * * *",react:"30 * * * *",close:"45 * * * *",maintain:"50 7 * * *"};function l(a){let b=a?`You are scoped to product ${a}. Pass product_id "${a}" wherever a tool accepts one.`:`You work across every product this token owns. Do not pass product_id unless you are deliberately narrowing to one — the engine has already balanced the work across products and campaigns, and narrowing undoes that.`,c=b=>`Start by calling register_routine with routine "${b}" and the cron you scheduled this
session on${a?`, and product_id "${a}"`:""}. It is what lets the console show when you last ran and
when you are due next. If you are late, that is how anyone finds out.`,d=`How work reaches you:

- next_work("<kind>") gives you your slice. The engine has already decided what is
  ready and divided it fairly across every product and campaign, so you do not
  choose what to work on and you must not go looking for more. Urgent items —
  someone who replied or clicked — come first automatically.
- finish_work(job_ids) hands back what you completed. Anything you do not finish
  returns to the pool on its own when the lease expires, so if you run low on room,
  stop. Never report work you did not do; the queue is what remembers, not you.
- If next_work returns nothing, say so in one line and stop. An empty slice with a
  non-zero still_waiting means the dispatcher has more coming next round, not that
  you should go and find it yourself.
- Before you finish, call backlog_report and say what is still waiting. A backlog
  nobody reports is a backlog nobody fixes — this system once hid nine thousand
  unplanned people behind a routine that cheerfully said "nothing to do".

How to use your sub-routines:

Each numbered step below is a sub-routine. Run it as its own sub-agent, in parallel
where the steps are independent, and give each one only the slice it needs. Ask each
to return a short summary — counts, and anything a person would want to know — never
its full working. Your own job is to split the work, read the summaries and write one
line of run notes. Do not do the per-person work yourself: your context is the thing
that runs out, and once it does the rest of the hour's work is lost.`;return[{key:"acquire",name:"1 — Acquire",cron:k.acquire,human:"every hour, on the hour",essential:!0,job:"Turn arrivals into people with a working sequence: read who they are, and make sure their segment has a playbook to run.",example:["Eight hundred leads arrive overnight; one call reads a hundred of them and eight of those run at once.","Anand reads as an engineering leader, so the engine swaps him onto that segment's playbook before his second message.","A segment with no playbook gets one written — once, for everybody in it, instead of once per person."],prompt:`${b}

${c("acquire")}

${d}

Your job is who these people are, and what sequence their segment runs. It is not
what any individual message says, and it is not one person's plan — a lead who has
done nothing has given no evidence that would justify a plan of their own. They run
their segment's playbook until they do something.

1.1 classify-batch
  next_work("classify") with limit 100. Split what comes back across parallel
  sub-agents, about a hundred people each, and have each one submit its whole
  batch in a single classify call.
  The rows you get are deliberately compact — name, role, company, how they
  arrived. That is usually enough. Call lead_card only for the ones it is not.
  Segment must come from the product's declared list; classify refuses anything
  else, and being refused means the answer is "unknown" or "off_icp", not a new
  bucket. Where email_kind is "personal" there is no company to research: read fit
  from the arrivals alone and set fit_known false rather than inventing an employer.
  A lead nobody can read is not a bad lead — their first real message should be
  short and ask something, because their answer is the only enrichment available.
  finish_work as each sub-agent reports.

1.2 playbook-writer
  next_work("playbook"). Each item names a segment with no sequence.
  Read what_works for that segment first, then get_brand, then write the playbook
  with upsert_playbook: the ordered steps, each with a channel, an angle, a reason
  and an offset in days.
  This is written once and then run by everybody in the segment, so it is worth
  more care than any single message. Around a third of the steps must use an angle
  that is not already proven — upsert_playbook refuses a sequence that spends every
  step on the current favourite, because that is how an untested angle never gets
  the sends that would prove it. Place the untested ones where they can actually be
  judged, not bolted onto the end.
  Offsets are intentions, not dates. The engine paces the real send from the
  person's temperature, so write the shape of the sequence and let it decide the days.

1.3 segment-auditor
  On your first run of the day only. Call report and look at the segment spread.
  Where two segments are plainly the same bucket under different names, say so in
  your run notes and name the merge you would make. Do not merge anything yourself:
  people are already running those playbooks, and a rename that lands mid-sequence
  changes what a person receives without anyone having asked for it.`},{key:"advance",name:"2 — Advance",cron:k.advance,human:"every hour, at :15",essential:!0,job:"Write the messages for the people worth writing for. Everyone else is already being served by the engine from their playbook.",example:["Rahul fits at 0.85 and his next step is due Thursday: subject, around 140 words, a link, an opt-out.","His step after that is WhatsApp — about 45 words, no link — so the same angle becomes different writing.","Four thousand colder leads get the same step rendered from the template, and cost nothing."],prompt:`${b}

${c("advance")}

${d}

Only people who have earned a written message reach you: someone hot, someone who
replied, or a strong fit early in their sequence. Everyone else already had their
next message rendered by the engine from their playbook's template, with their name
and their segment's pain merged in. That is not a lesser message — it goes through
the same brand kit, the same claims validation and the same send guardrails — it
simply does not need you.

2.1 compose-tier1
  next_work("compose") with limit 20. One sub-agent per person, in parallel.
  Each one: lead_card for context, then compose_batch for the step it names.
  Write to the channel's shape. lead_card lists each channel's real limits: an email
  carries a subject, a few hundred words, a link and an opt-out; a WhatsApp message
  is a couple of sentences with no link, and outside its reply window it must use an
  approved template. The same angle becomes two different pieces of writing.
  Read their prior touches. Never repeat a claim already made to them, never
  contradict one, and let the register escalate naturally across a sequence.
  The lower your confidence in someone, the harder the opening line has to work: be
  specific and a little cheeky rather than polite and generic, because a message that
  reads like every other message gets deleted unread. This never licenses a false
  claim — no invented capability, no number the product cannot back.

2.2 buffer-check
  Call backlog_report. If the compose queue is empty but people are still in flight,
  that is worth a line in your notes: it usually means the engine is serving them
  from their playbook, which is correct, but it is also what a silent breakage looks
  like. Say which of the two you think it is.

2.3 template-gap
  Where a person's step needed a template rung the product does not have, say so
  rather than working around it. Maintain drafts the missing rung tonight; writing a
  one-off message that papers over it means the gap is never found.`},{key:"react",name:"3 — React",cron:k.react,human:"every hour, at :30",essential:!0,job:"The people who did something. Smallest volume, highest value, and the only routine that rewrites one person's plan.",example:["Dhaval clicked the report link and did not sign up: the angle worked and the ask was wrong, so his next message asks something smaller.",'Deepa replied "ask in Q3" — campaign closed, cooling until July, her reason kept for whoever picks her up then.',"The surveillance objection has now ended three agency owners, so the fix goes in the playbook, not in one person's plan."],prompt:`${b}

${c("react")}

${d}

Everything here is urgent by construction: the engine only queues an escalation when
somebody clicked, replied, or went hot. The parts that could not wait for you have
already happened — a reply stopped their sequence within the minute, an unsubscribe
suppressed them, a temperature change moved their next message's date. What is left
is the judgment, and that is yours.

3.1 reply-handler
  next_work("escalate") and take the items whose reason is a reply.
  One sub-agent per person: read what they actually wrote, then record_reply with a
  grounded answer. Never invent a capability to close someone. A reply that says
  "not now" is a date, not a rejection — record the reason so whoever picks them up
  later knows what was said.

3.2 escalate-hot
  The rest of the escalate items: people who clicked and did not convert.
  One sub-agent per person. Read what_works once for the run, then their lead_card —
  it carries angles_tried, every angle already spent on them and whether they
  clicked. plan_goal refuses an angle they were sent and ignored, so read it first
  rather than being refused. An angle they clicked is not spent: it reached them and
  the ask was wrong, so keep the angle and make the ask smaller.
  Then plan_goal for the steps that remain, and compose_batch for the next one. Do
  not spread the remaining budget evenly: they are paying attention now and will not
  be next week, so weight it towards the front.

3.3 objection-rewriter
  When you have seen the same objection end three or more people in one segment,
  that is not a person-level problem. Say so, and fix the segment's playbook with
  upsert_playbook so everybody still running it gets the better sequence. One
  playbook edit is worth more than thirty rescued individuals.`},{key:"close",name:"4 — Close",cron:k.close,human:"every hour, at :45",essential:!0,job:"Decide who is done, who is finished with, and who is still running — and keep the checks that decide it honest.",example:["Priya's probes show an account and two sessions, so she is marked succeeded and her queued messages are cancelled.","A check that has passed for every single person it ever ran on is not evidence; it is a constant, and it has been ending campaigns for people who did nothing.","Rahul has spent his budget with no reply — a real ending, recorded as one."],prompt:`${b}

${c("close")}

${d}

4.1 verify-runner
  next_work("monitor") with limit 50. Split across sub-agents.
  For each person read last_probes — what the tools actually returned — alongside
  check_results and their last message. Where a check is undetermined, call
  verify_person, read the raw response, and resolve_check only if it plainly
  supports the verdict.

4.2 verdict-writer
  Decide, and submit them together with mark_state:
    succeeded  the evidence plainly shows it. Not "probably".
    failed     a real ending: they said no, or the budget and deadline are spent.
               Never because a check has simply not passed yet.
    continue   still running. Say in one line where they are.
  mark_state refuses "succeeded" unless every check the campaign defines has
  actually passed. If it refuses, the answer is to repair the check — never to route
  around it.

4.3 check-auditor
  On your first run of the day, look at both verification lists.
  verification_looks_wrong is two weeks with nothing passing — usually a check bound
  to the wrong tool.
  verification_too_easy is the more dangerous one: a check that has passed for
  everybody it has ever run on. That is not evidence, it is a constant, and it ends
  campaigns for people who have done nothing. Read one probe and compare the scope
  the args asked for against the scope the response says it used — a provider that
  ignores an argument it does not have the privilege for will answer about your own
  account instead. Repair both with verifiers and set_checks.`},{key:"maintain",name:"5 — Maintain",cron:k.maintain,human:"once a day, 07:50",essential:!1,job:"Finish what setup left half-done, learn from what has actually worked, and ask for the rest exactly once.",example:["A product with a welcome and nothing after it gets its day-three nudge and last call written in its brand voice, left as drafts.","The margin-leak angle has forty sends and no clicks, so it is retired from the playbooks that still use it.","Four campaigns have sat unstarted for six days — one notification says so, naming the lead source they are all waiting on."],prompt:`${b}

${c("maintain")}

${d}

This runs once a day. It finishes setup nobody came back to, learns from what has
actually happened, and asks for what only a person can give — once, not daily.

5.1 gaps-filler
  setup_gaps for each product. If gaps is empty, say "setup is complete" and move on.
  Fill what you can: missing ladder rungs get get_brand first so the copy suits the
  design, then upsert_template, always status "draft", checked with preview_template
  before you move on. A campaign with no verification plan gets verifiers then
  set_checks.
  Everything you write stays a draft. This routine never activates anything — a
  campaign that starts sending because a scheduled session decided it was ready is
  the worst possible surprise.

5.2 playbook-learner
  what_works for each product. Read it carefully: a rate over trackable sends is
  evidence, a null rate means those messages could never report and prove nothing
  either way, and an angle marked "untested" has too few sends to have failed — it
  has not been tried. Retiring one of those is how a product locks onto whatever won
  first and stops learning.
  Where an angle has genuinely lost with enough sends to say so, rewrite the
  playbooks that still use it. Where one has genuinely won, give it more of the
  sequence — but never all of it; upsert_playbook refuses a sequence with no
  untested angle in it, for the same reason.

5.3 owner-asks
  For what only a person can supply — a lead source, a send channel, a real trial
  link, a brand nobody has confirmed, a sending capacity too small for the campaign
  size — call notify_owner once, with all of it in one message. It is deduped for
  seven days, so repeating yourself costs you nothing and gains them nothing.
  Then say plainly what you drafted and what you are waiting on.`}]}async function m(a){if(!g(a.cron))throw Error(`"${a.cron}" is not a five-field cron expression`);let b=await (0,d.L)(),c=new Date;return await b.collection(e.I.routines).updateOne({orgId:a.orgId,productId:a.productId,key:a.key},{$set:{cron:a.cron,note:a.note??null,enabled:!0,lastSeenAt:c},$setOnInsert:{orgId:a.orgId,productId:a.productId,key:a.key,registeredAt:c}},{upsert:!0}),{cron:a.cron,nextRunAt:h(a.cron,c)}}async function n(a,b){let c=await (0,d.L)();return(await c.collection(e.I.routines).find({orgId:a,productId:b}).toArray()).filter(a=>j.od.includes(String(a.key))).map(a=>({key:String(a.key),cron:String(a.cron),note:a.note?String(a.note):void 0,enabled:!1!==a.enabled,registeredAt:new Date(String(a.registeredAt)),lastSeenAt:new Date(String(a.lastSeenAt??a.registeredAt))}))}async function o(a,b,c,f){let g=await (0,d.L)();await g.collection(e.I.routines).updateOne({orgId:a,productId:b,key:c},{$set:{enabled:f}})}async function p(a,b){let c=await (0,d.L)(),f=new Date,g=new Map((await n(a,b)).map(a=>[a.key,a])),i=new Map((await c.collection(e.I.routineRuns).aggregate([{$match:{orgId:a,productId:b,routine:{$in:[...j.od]}}},{$sort:{startedAt:-1}},{$group:{_id:"$routine",startedAt:{$first:"$startedAt"},status:{$first:"$status"}}}]).toArray()).map(a=>[String(a._id),a]));return l(b).map(a=>{let b=g.get(a.key),c=i.get(a.key),d=c?new Date(String(c.startedAt)):null,e=b?.cron??a.cron,j=h(e,d&&d>f?d:f),k="ok",l=0;if(b)if(b.enabled)if(d){let a=h(e,d);a&&f.getTime()>a.getTime()+12e5&&(k="late",l=Math.round((f.getTime()-a.getTime())/6e4))}else{let a=h(e,b.registeredAt);a&&f.getTime()>a.getTime()+12e5&&(k="never",l=Math.round((f.getTime()-a.getTime())/6e4))}else k="paused";else k="unregistered";return{key:a.key,name:a.name,registered:!!b,enabled:b?.enabled??!1,cron:e,cronFromRoutine:!!b,lastRunAt:d,lastStatus:c?String(c.status):null,nextRunAt:j,lateByMinutes:l,state:k}})}async function q(a,b){let c=await (0,d.L)(),f=`/products/${b}`,g=new Date;for(let d of(await p(a,b))){let h=`routine:${d.key}:late`;if("unregistered"===d.state||"paused"===d.state||"ok"===d.state){"ok"===d.state&&await c.collection(e.I.notifications).updateMany({orgId:a,productId:b,dedupeKey:h,readAt:null},{$set:{readAt:g}});continue}let j=await c.collection(e.I.notifications).findOne({orgId:a,productId:b,dedupeKey:h,readAt:null});if(j&&g.getTime()-new Date(String(j.updatedAt)).getTime()<36e5)continue;let k=function(a){if(a<90)return`${a} minutes`;let b=Math.round(a/60);return b<48?`${b} hours`:`${Math.round(b/24)} days`}(d.lateByMinutes);await (0,i.notify)({orgId:a,productId:b,severity:"critical",dedupeKey:h,title:"never"===d.state?`The ${d.name} routine has never run`:`The ${d.name} routine is ${k} late`,body:"never"===d.state?`It is scheduled as ${d.cron} but has not called in once. Check the schedule in Claude still has the connector attached.`:`Last run ${d.lastRunAt?.toISOString().slice(0,16).replace("T"," ")} UTC. Scheduled ${d.cron}.`,href:`${f}/logs`})}}},18962:(a,b,c)=>{c.d(b,{Iq:()=>t,J_:()=>m,O1:()=>B,Vf:()=>x,do:()=>l,ee:()=>A,mB:()=>u,nW:()=>w,od:()=>g,v:()=>z});var d=c(12518),e=c(51420),f=c(38930);let g=["acquire","advance","react","close","maintain"];function h(a){return"string"==typeof a&&g.includes(a)}function i(a){let b;if(void 0!==a){try{b=JSON.stringify(a)??String(a)}catch{b=String(a)}return b.length>4e3?`${b.slice(0,4e3)}… [${b.length} chars]`:b}}let j=a=>"number"==typeof a&&Number.isFinite(a)?a:0,k={work_items:["work item","work items"],read:["card read","cards read"],classified:["person classified","people classified"],planned:["plan written","plans written"],plan_steps:["step","steps"],composed:["message written","messages written"],succeeded:["succeeded","succeeded"],failed:["failed","failed"],continued:["still running","still running"],checks_resolved:["check resolved","checks resolved"],checks_set:["check set","checks set"],probed:["person probed","people probed"],approved:["approved","approved"],rejected:["rejected","rejected"],leads_ingested:["lead in","leads in"],first_touches:["first touch queued","first touches queued"],sent:["sent","sent"],held:["held for review","held for review"],deferred:["deferred to a civil hour","deferred to a civil hour"],reconciled:["reconciled","reconciled"]};function l(a){return Object.entries(a).filter(([,a])=>a>0).map(([a,b])=>{let c=k[a];return c?`${b} ${1===b?c[0]:c[1]}`:`${b} ${a.replace(/_/g," ")}`}).join(" \xb7 ")}function m(a){let b={};for(let c of a)for(let[a,d]of Object.entries(c.counters??{}))b[a]=(b[a]??0)+d;return b}async function n(a){let b=await (0,e.L)(),c=new d.ObjectId;return await b.collection(f.I.routineRuns).insertOne({_id:c,orgId:a.orgId,productId:a.productId,userId:a.userId,routine:a.kind,status:"running",startedAt:a.at,lastCallAt:a.at,endedAt:null,ms:0,calls:0,errors:0,counters:{},firstError:null}),c}async function o(a,b,c,d,g){let i=await (0,e.L)(),j="string"==typeof d.product_id?d.product_id:"",k="register_routine"===c?d.routine:"sweep"===c?d.scope:void 0,l=await i.collection(f.I.routineRuns).findOne({orgId:a,userId:b,status:"running",lastCallAt:{$gte:new Date(g.getTime()-3e5)}},{sort:{lastCallAt:-1}});return h(k)?l&&l.routine===k?p(l,j):l&&"ad-hoc"===l.routine?(await i.collection(f.I.routineRuns).updateOne({_id:l._id},{$set:{routine:k}}),p(l,j)):(l&&await v(l,g),{runId:await n({orgId:a,userId:b,productId:j,kind:k,at:g}),productId:j}):l?p(l,j):{runId:await n({orgId:a,userId:b,productId:j,kind:"ad-hoc",at:g}),productId:j}}async function p(a,b){let c=String(a.productId??"")||b;if(!a.productId&&b){let c=await (0,e.L)();await c.collection(f.I.routineRuns).updateOne({_id:a._id},{$set:{productId:b}})}return{runId:a._id,productId:c}}let q=["register_routine","routine_status","sweep","lead_card","report","list_products","next_work","finish_work","backlog_report"],r={acquire:[...q,"classify","save_enrichment","upsert_playbook","what_works","verifiers","set_checks"],advance:[...q,"compose_batch","preview_template","get_brand"],react:[...q,"plan_goal","compose_batch","record_reply","what_works","upsert_playbook"],close:[...q,"mark_state","resolve_check","verify_person","verifiers","set_checks","record_reply"],maintain:[...q,"setup_gaps","notify_owner","get_brand","upsert_template","preview_template","draft_campaign","upsert_playbook","what_works"]};async function s(a,b){let c=await (0,e.L)(),d=await c.collection(f.I.routineRuns).findOne({orgId:a,userId:b,status:"running",lastCallAt:{$gte:new Date(Date.now()-3e5)}},{sort:{lastCallAt:-1},projection:{routine:1}}),g=d?String(d.routine):"";return h(g)?g:null}async function t(a,b,c){let d=await s(a,b);if(!d||r[d].includes(c))return null;let e=g.filter(a=>r[a].includes(c));return`${c} is not part of the ${d} routine${e.length?` — it belongs to ${e.join(" and ")}`:""}. Stop and do only the steps in your own prompt. If you believe you should be calling this, the prompt saved in this routine is probably the wrong one: check it against the Routines page.`}async function u(a){try{let b=await (0,e.L)(),c=a.at??new Date,{runId:g,productId:h}=await o(a.orgId,a.userId,a.tool,a.args,c);await b.collection(f.I.routineCalls).insertOne({_id:new d.ObjectId,runId:g,orgId:a.orgId,productId:h,tool:a.tool,args:i(a.args)??null,result:a.error?null:i(a.result)??null,error:a.error??null,ms:a.ms,ts:c});let k=a.error?{}:function(a,b,c){let d={},e=c??{};switch(a){case"sweep":d.work_items=j(e.total_work_items);break;case"classify":d.classified=j(e.updated);break;case"plan_goal":d.planned=1,d.plan_steps=j(e.steps);break;case"compose_batch":d.composed=j(e.queued);break;case"mark_state":for(let a of Array.isArray(e.verdicts)?e.verdicts:[])"succeeded"===a.state?d.succeeded=(d.succeeded??0)+1:"failed"===a.state?d.failed=(d.failed??0)+1:d.continued=(d.continued??0)+1;break;case"resolve_check":d.checks_resolved=1;break;case"set_checks":d.checks_set=j(e.checks);break;case"verify_person":d.probed=1;break;case"approve":d["reject"===b.decision?"rejected":"approved"]=j(e.updated);break;case"poll_sources":for(let a of Array.isArray(e.results)?e.results:[])d.leads_ingested=(d.leads_ingested??0)+j(a.created)+j(a.attachedToExisting),d.first_touches=(d.first_touches??0)+j(a.firstTouchesQueued);break;case"fire_due":d.sent=j(e.sent),d.reconciled=j(e.reconciled?.checked);break;case"lead_card":d.read=1}return d}(a.tool,a.args,a.result),l={calls:1,errors:+!!a.error};for(let[a,b]of Object.entries(k))l[`counters.${a}`]=b;await b.collection(f.I.routineRuns).updateOne({_id:g},{$inc:l,$set:{lastCallAt:c}}),a.error&&await b.collection(f.I.routineRuns).updateOne({_id:g,firstError:null},{$set:{firstError:`${a.tool}: ${a.error}`}})}catch{}}async function v(a,b){let c=await (0,e.L)(),d=new Date(String(a.startedAt)),g=new Date(String(a.lastCallAt??a.startedAt)),h=b.getTime()-g.getTime()>18e5?"stalled":j(a.errors)>0?"error":"ok";await c.collection(f.I.routineRuns).updateOne({_id:a._id},{$set:{status:h,endedAt:g,ms:g.getTime()-d.getTime()}})}async function w(a=new Date){let b=await (0,e.L)(),c=await b.collection(f.I.routineRuns).find({status:"running",lastCallAt:{$lt:new Date(a.getTime()-3e5)}}).limit(200).toArray();for(let b of c)await v(b,a);return c.length}async function x(a){try{let b=await (0,e.L)(),c=new Date,g=new d.ObjectId;await b.collection(f.I.routineRuns).insertOne({_id:g,orgId:a.orgId,productId:a.productId,userId:"engine",routine:"engine",status:a.error?"error":"ok",startedAt:a.startedAt,lastCallAt:c,endedAt:c,ms:c.getTime()-a.startedAt.getTime(),calls:1,errors:+!!a.error,counters:a.counters,firstError:a.error??null}),await b.collection(f.I.routineCalls).insertOne({_id:new d.ObjectId,runId:g,orgId:a.orgId,productId:a.productId,tool:"tick",args:null,result:i(a.report)??null,error:a.error??null,ms:c.getTime()-a.startedAt.getTime(),ts:c})}catch{}}function y(a){let b=new Date(String(a.startedAt)),c=new Date(String(a.lastCallAt??a.startedAt));return{id:String(a._id),routine:String(a.routine),status:String(a.status),startedAt:b.toISOString(),endedAt:a.endedAt?new Date(String(a.endedAt)).toISOString():null,ms:j(a.ms)||Math.max(0,c.getTime()-b.getTime()),calls:j(a.calls),errors:j(a.errors),counters:a.counters??{},firstError:a.firstError?String(a.firstError):null}}async function z(a,b,c={}){let d=await (0,e.L)(),g={orgId:a,productId:b};return c.routine&&"all"!==c.routine&&(g.routine=c.routine),(await d.collection(f.I.routineRuns).find(g).sort({startedAt:-1}).limit(c.limit??60).toArray()).map(y)}async function A(a,b){let c=await (0,e.L)(),d=await c.collection(f.I.routineRuns).aggregate([{$match:{orgId:a,productId:b}},{$sort:{startedAt:-1}},{$group:{_id:"$routine",run:{$first:"$$ROOT"}}}]).toArray(),g={};for(let a of d)g[String(a._id)]=y(a.run);return g}async function B(a,b){let c=await (0,e.L)();return d.ObjectId.isValid(b)?(await c.collection(f.I.routineCalls).find({orgId:a,runId:new d.ObjectId(b)}).sort({ts:1}).limit(500).toArray()).map(a=>({id:String(a._id),tool:String(a.tool),args:a.args?String(a.args):null,result:a.result?String(a.result):null,error:a.error?String(a.error):null,ms:j(a.ms),ts:new Date(String(a.ts)).toISOString()})):[]}},30752:(a,b,c)=>{c.d(b,{McpClient:()=>g,c:()=>j});var d=c(77598),e=c(36719);let f="2025-06-18";class g{constructor(a,b,c){for(let[d,e]of(this.serverUrl=a,this.token=b,this.negotiatedVersion=f,this.initialized=!1,this.nextId=1,this.schemas=new Map,Object.entries(c??{})))this.schemas.set(d,e)}headers(){let a={"content-type":"application/json",accept:"application/json, text/event-stream",authorization:`Bearer ${this.token}`,"mcp-protocol-version":this.negotiatedVersion};return this.sessionId&&(a["mcp-session-id"]=this.sessionId),a}async post(a){return fetch(this.serverUrl,{method:"POST",headers:this.headers(),body:JSON.stringify(a),signal:AbortSignal.timeout(3e4)})}async rpc(a,b){await this.ensureInitialized();let c=this.nextId++,d=await this.post({jsonrpc:"2.0",id:c,method:a,params:b});if(!d.ok)throw Error(`MCP ${a} failed: HTTP ${d.status}`);let e=await h(d,c);if(e.error)throw Error(`MCP ${a} error: ${e.error.message}`);if(void 0===e.result)throw Error(`MCP ${a} returned no result`);return e.result}async ensureInitialized(){if(this.initialized)return;this.initialized=!0;let a=this.nextId++,b=await this.post({jsonrpc:"2.0",id:a,method:"initialize",params:{protocolVersion:f,capabilities:{},clientInfo:{name:"conversion-engine",version:"0.1.0"}}});if(!b.ok)throw this.initialized=!1,Error(`MCP initialize failed: HTTP ${b.status}`);let c=b.headers.get("mcp-session-id");c&&(this.sessionId=c);let d=await h(b,a);if(d.error)throw this.initialized=!1,Error(`MCP initialize error: ${d.error.message}`);d.result?.protocolVersion&&(this.negotiatedVersion=d.result.protocolVersion),await this.post({jsonrpc:"2.0",method:"notifications/initialized"}).catch(()=>void 0)}async listTools(){let a,b=[];do{let c=await this.rpc("tools/list",a?{cursor:a}:{});for(let a of c.tools??[])this.schemas.set(a.name,a.inputSchema);b.push(...c.tools??[]),a=c.nextCursor}while(a);return b}async callTool(a,b){let c=this.schemas.get(a);if(c){let d=(0,e.a)(c,b);if(d.length>0)throw Error(`MCP tool "${a}" rejects these arguments: ${d.join("; ")}`)}let d=await this.rpc("tools/call",{name:a,arguments:b});if(d.isError){let b=i(d.content),c="string"==typeof b?b:b?JSON.stringify(b):"";throw Error(`MCP tool "${a}" reported an error${c?`: ${c.slice(0,500)}`:""}`)}return d.structuredContent??i(d.content)??d}}async function h(a,b){let c,d=a.headers.get("content-type")??"",e=await a.text();if(!d.includes("text/event-stream"))return e.trim()?JSON.parse(e):{jsonrpc:"2.0",id:b};for(let a of e.split(/\n\n/)){let d,e=a.split("\n").filter(a=>a.startsWith("data:")).map(a=>a.slice(5).trim()).join("");if(e){try{d=JSON.parse(e)}catch{continue}if(d.id===b)return d;(void 0!==d.result||d.error)&&(c??=d)}}if(c)return c;throw Error("MCP response contained no usable event")}function i(a){if(Array.isArray(a)){for(let b of a)if(b&&"object"==typeof b&&"text"===b.type){let a=b.text??"";try{return JSON.parse(a)}catch{return a}}return a}}function j(a){let b=a.map(a=>`${a.name}:${JSON.stringify(a.inputSchema)}`).sort().join("|");return(0,d.createHash)("sha256").update(b).digest("hex")}},36719:(a,b,c)=>{c.d(b,{a:()=>e,h:()=>f});let d={string:a=>"string"==typeof a,number:a=>"number"==typeof a&&Number.isFinite(a),integer:a=>"number"==typeof a&&Number.isInteger(a),boolean:a=>"boolean"==typeof a,array:a=>Array.isArray(a),object:a=>"object"==typeof a&&null!==a&&!Array.isArray(a),null:a=>null===a};function e(a,b){if(!a||"object"!=typeof a)return[];let c=[],e=a.properties??{};for(let d of a.required??[])void 0===b[d]&&c.push(`${d} is required but was not supplied`);for(let[f,g]of Object.entries(b)){let b=e[f];if(!b){if(!1===a.additionalProperties){let a=Object.keys(e);c.push(`${f} is not an argument of this tool${a.length?` (it accepts ${a.join(", ")})`:""}`)}continue}let h=function(a,b){let c=a.type;if(!c)return null;let e=(Array.isArray(c)?c:[c]).filter(a=>a in d);return 0===e.length||e.some(a=>d[a]?.(b))?null:`expected ${e.join(" or ")}, got ${null===b?"null":Array.isArray(b)?"array":typeof b}`}(b,g);h&&c.push(`${f}: ${h}`),Array.isArray(b.enum)&&b.enum.length>0&&!b.enum.includes(g)&&c.push(`${f}: expected one of ${b.enum.map(a=>JSON.stringify(a)).join(", ")}`)}return c}function f(a){return Array.isArray(a?.required)?a.required.map(String):[]}},63442:(a,b,c)=>{c.d(b,{MI:()=>g,tr:()=>f,uZ:()=>e});var d=c(40197);let e=d.Yj().regex(/^[0-9a-f]{24}$/,"expected an ObjectId hex string");d.Ik({orgId:e,productId:e});let f=d.k5(["email","whatsapp","sms","in_app","linkedin","push"]),g=d.k5(["hot","warm","cold","dead"]);d.k5(["lead","trial_started","activated","paying","dormant","churned"]),d.k5(["api_key","oauth2","smtp","bearer","mcp_oauth","mcp_bearer","mcp_stdio"]),d.k5(["pending","verifying","provisioning","warming","healthy","degraded","expired","revoked","disabled"]),d.ai().nonnegative(),d.ai().min(0).max(1)},90471:(a,b,c)=>{c.d(b,{resolveSecret:()=>j});var d=c(12518),e=c(51420),f=c(38930),g=c(93110),h=c(57712),i=c(37116);async function j(a,b,c){let h=await (0,e.L)(),i=await h.collection(f.I.credentials).findOne({orgId:a,connectionId:b,status:{$in:["verified","degraded"]}});if(!i)throw Error(`no usable credential for connection ${b}`);let j=await k(a,b,i);return j||(await h.collection(f.I.audit).insertOne({_id:new d.ObjectId,orgId:a,actorType:"engine",actorId:c,action:"credential.resolve",target:b,at:new Date}),await h.collection(f.I.credentials).updateOne({_id:i._id},{$set:{lastUsedAt:new Date}}),(0,g.JM)(i))}async function k(a,b,c){let j=c.refreshAfter,k=c.refreshTokenEnc;if(!j||!k||new Date(j)>new Date)return null;let l=await (0,e.L)(),m=await l.collection(f.I.connections).findOne({_id:new d.ObjectId(b)});if(!m)return null;let n=m.oauth,o="oauth2"===m.authType;if(!o&&(!n?.metadata||!m.serverUrl)||o&&"google"!==m.provider)return null;try{let c=o?await (0,i.I9)({client:(0,i.lE)(),refreshToken:(0,g.JM)(k)}):await (0,h.Be)({metadata:n.metadata,clientId:n.clientId,clientSecret:n.clientSecret,refreshToken:(0,g.JM)(k),resource:String(m.serverUrl)}),d=c.expires_in?new Date(Date.now()+1e3*c.expires_in):void 0;return await l.collection(f.I.credentials).updateOne({orgId:a,connectionId:b},{$set:{...(0,g.EX)(c.access_token),...c.refresh_token?{refreshTokenEnc:(0,g.EX)(c.refresh_token)}:{},expiresAt:d,refreshAfter:d?new Date(d.getTime()-12e4):void 0,status:"verified"}}),c.access_token}catch{throw await l.collection(f.I.credentials).updateOne({orgId:a,connectionId:b},{$set:{status:"expired"}}),await l.collection(f.I.connections).updateOne({_id:new d.ObjectId(b)},{$set:{status:"degraded"}}),Error(o?"Google refused the refresh token — reconnect this mailbox":"OAuth token expired and refresh failed — reconnect this server")}}},93110:(a,b,c)=>{c.d(b,{EX:()=>i,JM:()=>j});var d=c(77598);let e="aes-256-gcm";function f(){let a=process.env.MASTER_KEY_B64;if(!a)throw Error("MASTER_KEY_B64 is not set");let b=Buffer.from(a,"base64");if(32!==b.length)throw Error("MASTER_KEY_B64 must decode to 32 bytes");return b}function g(a,b){let c=(0,d.randomBytes)(12),f=(0,d.createCipheriv)(e,b,c),g=Buffer.concat([f.update(a),f.final()]);return{blob:Buffer.concat([c,f.getAuthTag(),g]).toString("base64")}}function h(a,b){let c=Buffer.from(a,"base64"),f=c.subarray(0,12),g=c.subarray(12,28),h=(0,d.createDecipheriv)(e,b,f);return h.setAuthTag(g),Buffer.concat([h.update(c.subarray(28)),h.final()])}function i(a){let b=(0,d.randomBytes)(32),{blob:c}=g(Buffer.from(a,"utf8"),b),{blob:e}=g(b,f());return{ciphertext:c,encDek:e,keyVersion:1,nonce:""}}function j(a){let b=h(a.encDek,f());return h(a.ciphertext,b).toString("utf8")}}};