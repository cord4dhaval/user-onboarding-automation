/**
 * The words a subject line may use: everyday English a school child knows, and the office words
 * every Indian office says out loud.
 *
 * Dhaval, 2026-09-29: the inbox line was still hard to read. "Who covered what last week", "The
 * day's answer without asking", "The waiting time, counted" all passed the old check, because the
 * old check was a list of about thirty banned words and every word not on it went through. So the
 * check is turned around: a subject word passes only when it is on this list, is one of the lead's
 * own words (their trade, their company), or is a digit. Anything else is written again.
 *
 * Curated by hand from the first two levels of learner English (A1 and A2) rather than taken from
 * a web frequency list: the web's most used words include information, development and management,
 * which are common and still hard. Words that are simple but mostly used as idioms in a subject
 * ("covered" for handled, "slips", "ate the week") are left out on purpose.
 */

const EVERYDAY = `
a about above after again against ago all almost alone along already also always am an and another
any anyone anything are around as ask at away back bad be because been before behind being below
best better between big both but by can cannot come could day days did do does doing done down
during each early easy else end enough even ever every everyone everything far few first for from
full get give go going gone good got great had half hand hard has have he help her here high him
his home how i if in into is it its just keep kind know last late later least left less let like
little long look lot lots made make many may me more most much must my near need never new next
no nobody none nor not nothing now of off often old on once one only open or other our out over
own part past per place put quite rather real really right same say see she should show side since
small so some someone something sometimes soon still such sure take than that the their them then
there they thing things think this those though through till time to today together tomorrow too
top true try two under until up us use used very want was way we well were what when where which
while who whole why will with without work would yes yesterday yet you your yours
able across add again ahead amount answer any area arrive asked asking bank become begin believe
bill bit block body book boss box break bring brought build busy buy call called came care carry
case cash catch cause change check child city clean clear close closed cold company cost count
country course cut dark date dead deal dear decide desk die different do door double draw dream
drive drop each ear eat eight eleven empty enjoy enter even evening event exact face fact fail fall
family fast father fear feel feeling felt fifteen fifty fight fill find fine finish fire five fix
floor fly follow food foot forget found four free friend front fun game gave girl glad goes gone
group grow guess guy hair happen happened happy hate head hear heard heart heavy held hello here
hold hope hot hour hours house hundred idea important inside job join jump key kid kill knew land
large laugh lead learn leave lie life light line list listen live lose lost loud love low main man
matter mean meet meeting men mind minute minutes miss moment money month months morning mother move
music name nearly need news nice night nine noon note number office ok okay order paid pay people
person phone pick picture piece plan play please point poor post power press pretty price problem
pull push question quick quickly quiet rain ran reach read ready reason red remember rest return
ride road room round rule run running safe said sale sat save saw school seat second seem seen
sell send sent set seven share short shut sick sign simple sit six sleep slow smile sold soon sorry
sound speak spend spent stand start started stay step stop story street strong study stuff sure
table talk tea team tell ten test than thank thanks thousand three throw tired told took total
town train tree trip trouble turn twelve twenty type understand upon wait waiting walk wall war
warm watch water week weekend weeks went white whose wife win window wish woman word words worry
worth write wrong year years young
account address age answered bag base bed bit board brother buying cannot car card cars centre
center chair chance chat cheap child class clock computer copy corner daily date deliver delivery
diary driver dress earn email end ends extra field file files finger fixed form forms goods half
hall held hire hired hospital hotel hurry income job jobs keys kitchen labour labor lady late later
leader less letter level lunch mail market meal member mobile model month notes online page pages
paper parent party pass pen plant pocket print prints proof rate record reply replied replies
report reports rest result results rich salary sheet shift shop shops shown site size skill sort
spare stage staff start stock store sum supply tax taxi text ticket tool tools trade trust truck
unit van visit wage wages wall worker workers yard
raise quit fee private festival review normal notice guest teacher student doctor nurse machine due
program programme ship charge match rush message mark detail buyer seller owner product
example actually memory usually usual instead plain probably finally twice either written taken known kept built
given begun chosen driven eaten fallen forgotten grown hidden spoken stolen thrown understood worn won wrote began
broke broken chose drove fell forgot grew hid rode rang rose shot sang slept spoke stood threw woke wore led meant
met hit hurt lay itself yourself themselves myself ourselves himself herself score split replace request explain
separate business delay outside several actual third conversation present camera decision average active design
designer engineer developer support service voice edit single dinner tonight shape pm
these fit useful remind disappear rise mix including wonder system season quarter web tab emergency
bought pickup technician experience workshop profit waste role
touch compare agree offer prefer improve include repeat suggest travel wash cook describe expect imagine manage
receive remove repair search appear develop protect measure
monday tuesday wednesday thursday friday saturday sunday
january february march april june july august september october november december
morning afternoon evening night noon midnight daily weekly monthly hourly
one two three four five six seven eight nine ten eleven twelve hundred thousand lakh crore
`;

/** The office words every Indian office says every day, even where a school list leaves them out. */
const INDIAN_OFFICE = `
pending staff report reports reply replies order orders site sites client clients customer customers
dealer dealers vendor vendors supplier suppliers stock bill bills billing invoice invoices payment payments
salary salaries leave leaves boss manager managers team teams shift shifts desk desks meeting meetings
laptop laptops computer computers mobile app apps excel whatsapp tally gst email emails mail mails
sheet sheets file files update updates target targets sales branch godown factory showroom warehouse
export import paperwork follow task tasks project projects deadline office
load loading screen internet click link login online website
punch stuck diwali holi audit handover youtube google
screenshot screenshots install installed setup status admin appraisal senior supervisor dispatch chai approve
approval confirm resign inbox schedule reminder log login logout data wfh
`;

/** Doing words, for the "say it as a sentence" check: a line with none of these is a label, not speech. */
const DOING = `
am is are was were be been being has have had do does did done can could will would shall should may
might must ask asked asking answer answered arrive begin bring brought build buy call called came
care carry catch change check choose close come comes coming cost count cut decide deliver did do
drive drop earn eat end ends enter fail fall feel felt fill find finish fix follow forget found get
gets getting give gives go goes going gone got grow guess happen happened hear heard help hire hold
hope join keep keeps kept know knew knows lead learn leave leaves left let lie lose loses lost love
make makes making mean meet miss move moves need needs open opens order orders paid pay pays pick
plan plans play print pull push put reach read reply replied replies rest return ride run runs
running said sat save saw say says see seen sees sell send sends sent set share show shows shown sit
sleep slow speak spend spends spent stand start starts started stay stays stop stops take takes
taking talk talks tell tells think thinks throw told took try turn understand use uses used visit
wait waits waiting walk want wants watch went win wish work works worked working worry write writes
wrote score skip confirm log ship ping lay cover email text message install add split record mark nudge track flag
slip stall chase explain replace request delay compare rank remind ring scroll trace switch renew edit design approve
wonder lean agree fit belong book bill claim collect copy fix grow hide improve include join like look matter mind note
notice offer own pass prefer prepare prove quit raise realise realize reduce refuse remember rent repeat report ruin
rush serve settle sign sound stick study suggest supply support suppose surprise test thank touch train travel treat
trust type become believe clean cook deliver depend describe develop enjoy expect face feed fight happen hang imagine
last listen live manage measure name place point produce protect rate receive relax remove repair roll search seem
shine shop sort steer store suffer suit trade appear disappear exist miss count check lose sit stand set led began
became grew hid met hit hurt lay meant rode rose spoke stood threw wore brought bought caught chose drove fell forgot
`;

const words = (text: string) => new Set(text.trim().split(/\s+/).filter(Boolean));

export const EVERYDAY_WORDS: ReadonlySet<string> = words(EVERYDAY);
export const INDIAN_OFFICE_WORDS: ReadonlySet<string> = words(INDIAN_OFFICE);
const DOING_WORDS: ReadonlySet<string> = words(DOING);

/** The word as written and the plain forms it could come from: waits → wait, stopped → stop, bookings → book. */
function baseForms(raw: string): string[] {
  const w = raw.toLowerCase().replace(/[’']s$/, "").replace(/[’']$/, "");
  // Two rounds, so a plural of a longer form comes back too: bookings → booking → book.
  const once = suffixForms(w);
  return [...new Set([...once, ...once.flatMap(suffixForms)])];
}

function suffixForms(w: string): string[] {
  const out = new Set([w]);
  const add = (x: string) => { if (x.length >= 2) out.add(x); };
  if (w.endsWith("ies")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("es")) add(w.slice(0, -2));
  if (w.endsWith("s")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("ed")) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith("ing")) { add(w.slice(0, -3)); add(`${w.slice(0, -3)}e`); }
  if (w.endsWith("er")) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (w.endsWith("est")) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  if (w.endsWith("ly")) add(w.slice(0, -2));
  if (w.endsWith("ier")) add(`${w.slice(0, -3)}y`);
  if (w.endsWith("iest")) add(`${w.slice(0, -4)}y`);
  if (w.endsWith("ily")) add(`${w.slice(0, -3)}y`);
  // stopped → stopp → stop, running → runn → run
  for (const x of [...out]) if (/([b-df-hj-np-tv-z])\1$/.test(x)) add(x.slice(0, -1));
  return [...out];
}

/** True when the word is everyday English or an Indian office word, in any of its plain forms. */
export function isEasyWord(raw: string): boolean {
  return baseForms(raw).some((w) => EVERYDAY_WORDS.has(w) || INDIAN_OFFICE_WORDS.has(w));
}

/** True when the word is a doing word, in any of its plain forms. A long word ending in -ed is one too (logged, approved). */
export function isDoingWord(raw: string): boolean {
  const w = raw.toLowerCase();
  return (w.length >= 5 && w.endsWith("ed")) || baseForms(w).some((x) => DOING_WORDS.has(x));
}

/** True when one of the plain forms of the word is in the given list, for the lead's own words. */
export function isOneOf(raw: string, list: ReadonlySet<string>): boolean {
  return baseForms(raw).some((w) => list.has(w));
}
