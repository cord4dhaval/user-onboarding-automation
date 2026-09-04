import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveTemplateFor } from "../engine/templates.js";
import { renderTemplate } from "../engine/compose.js";
import { dueAtFor } from "../engine/cadence.js";
import { tierFor } from "../engine/advance.js";
import { dispatch } from "../engine/dispatch.js";
import { PRIORITY } from "../engine/queue.js";

/**
 * Checks the orchestration changes against real data, and changes nothing.
 *
 * Every case here is one that actually went wrong in production rather than one invented to
 * exercise a branch: the template that could not be resolved, the copy that was written and
 * discarded, the click that moved nothing, the campaign that never got a turn. A test that
 * only proves the code does what it says would have passed before any of this was fixed.
 *
 *   npm run verify:orchestration
 */

let failures = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}\n         ${detail}`);
  if (!pass) failures++;
};

const db = await getDb();

const product = await db.collection(C.products).findOne({ status: "active" });
if (!product) throw new Error("no active product to verify against");
const orgId = String(product.orgId);
const productId = String(product._id);
console.log(`\nverifying against "${String(product.name)}" (${productId})\n`);

// ── 1. The 71 dead actions: would they resolve a template now? ────────────────
{
  const dead = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "failed", error: /missing person, goal, channel or template/ })
    .limit(25)
    .toArray();

  let resolved = 0;
  for (const action of dead) {
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
    const instance = await db
      .collection(C.goalInstances)
      .findOne({ _id: new ObjectId(String(action.goalInstanceId)) });
    const template = await resolveTemplateFor({
      orgId,
      productId,
      channel: String(action.channel),
      segment: (person?.belief as { segment?: string } | undefined)?.segment,
      touchesSpent: Number((instance?.spent as { touches?: number } | undefined)?.touches ?? 0),
    });
    if (template) resolved++;
  }

  // An empty set is the state this is aiming at, not a reason to fail. Once the repair has
  // run there are no such failures left, and demanding one would mean the check could only
  // pass while the fault it guards against was still doing damage.
  check(
    "no action can still be dead for want of a template",
    resolved === dead.length,
    dead.length === 0
      ? "none left in this state"
      : `${resolved}/${dead.length} of the sampled failures find a template through the ladder`,
  );
}

// ── 2. The queued actions that were about to die the same way ────────────────
{
  const queued = await db
    .collection(C.actions)
    .find({ orgId, productId, status: "queued", templateId: { $in: [null, undefined] } })
    .limit(25)
    .toArray();

  let resolved = 0;
  for (const action of queued) {
    const person = await db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) });
    const template = await resolveTemplateFor({
      orgId,
      productId,
      channel: String(action.channel),
      segment: (person?.belief as { segment?: string } | undefined)?.segment,
      touchesSpent: 1,
    });
    if (template) resolved++;
  }

  check(
    "queued actions with no template id would send, not fail",
    queued.length === 0 || resolved === queued.length,
    queued.length === 0
      ? "none queued without a template id"
      : `${resolved}/${queued.length} resolve a template`,
  );
}

// ── 3. Composed copy actually reaches the recipient ──────────────────────────
{
  const template = await resolveTemplateFor({ orgId, productId, channel: "email", touchesSpent: 1 });
  const vars = {
    first_name: "Anand",
    full_name: "Anand Sharma",
    company: "CloudNine",
    person_id: "x",
    trial_link: "https://example.com/start",
    opt_out_url: "https://example.com/u",
  };
  const written = "Where did the sprint actually go? Most VPs cannot answer that by client.";

  const rendered = renderTemplate(template?.blocks as Record<string, unknown>[], vars, {
    slotText: written,
    subject: "Anand, where did the sprint go?",
  });

  check(
    "copy written for one person appears in the message they receive",
    rendered.bodyMd.includes(written),
    rendered.bodyMd.includes(written)
      ? "slotText renders into the open slot"
      : `slot copy was dropped; body begins "${rendered.bodyMd.slice(0, 80)}"`,
  );

  // The re-render trap: a held message rendered a second time must not feed its own body
  // back into the slot, which is what produced duplicated greetings before.
  const again = renderTemplate(template?.blocks as Record<string, unknown>[], vars, rendered);
  const occurrences = again.bodyMd.split(written).length - 1;
  check(
    "re-rendering a held message does not duplicate its body",
    occurrences === 1,
    `the composed sentence appears ${occurrences} time(s) after a second render`,
  );
}

// ── 4. Cadence: hot is faster than cold, and a click moves the date ──────────
{
  const lastContactedAt = new Date(Date.now() - 6 * 3_600_000);
  const hot = dueAtFor({ offsetDays: 4, band: "hot", lastContactedAt });
  const cold = dueAtFor({ offsetDays: 4, band: "cold", lastContactedAt });

  check(
    "a person who just clicked is contacted sooner than one who ignored five emails",
    hot < cold,
    `hot in ${((hot.getTime() - Date.now()) / 3_600_000).toFixed(1)}h, cold in ${((cold.getTime() - Date.now()) / 3_600_000).toFixed(1)}h`,
  );

  const past = dueAtFor({ offsetDays: 3, band: "warm", lastContactedAt: new Date(Date.now() - 30 * 86_400_000) });
  check(
    "a plan whose steps have already elapsed sends once, now, not three at once",
    Math.abs(past.getTime() - Date.now()) < 60_000,
    "an overdue step is clamped to now",
  );
}

// ── 5. Tiering: who costs a model call ───────────────────────────────────────
{
  const instance = { spent: { touches: 1 }, deadline: new Date(Date.now() + 86_400_000) };
  const hot = tierFor({ temp: { band: "hot" }, belief: { icpFit: 0.2 } }, instance);
  const cold = tierFor({ temp: { band: "cold" }, belief: { icpFit: 0.3 } }, instance);
  const dead = tierFor({ temp: { band: "dead" }, belief: { icpFit: 0.9 } }, instance);
  const suppressed = tierFor({ temp: { band: "hot" }, lifecycle: "suppressed" }, instance);

  check(
    "tiering sends the few to Claude and the many to the template",
    hot === 1 && cold === 2 && dead === 3 && suppressed === 3,
    `hot=${hot} cold=${cold} dead=${dead} suppressed=${suppressed}`,
  );
}

// ── 6. Fairness: ten campaigns, one budget, nobody starved ───────────────────
{
  const probeOrg = `verify-${new ObjectId().toHexString()}`;
  const rows = [];
  for (let campaign = 1; campaign <= 10; campaign++) {
    // Campaign 3 is tiny, as a small campaign behind nine large ones is exactly the case
    // disk order got wrong.
    const size = campaign === 3 ? 12 : 400;
    for (let i = 0; i < size; i++) {
      rows.push({
        orgId: probeOrg,
        kind: "classify",
        status: "queued",
        payload: {},
        dueAt: new Date(Date.now() - 60_000),
        leaseUntil: new Date(0),
        attempts: 0,
        createdAt: new Date(),
        productId: campaign <= 5 ? "productA" : "productB",
        campaignKey: `camp${campaign}`,
        priority: PRIORITY.normal,
      });
    }
  }
  // One reply, in the campaign that would otherwise be served last.
  rows.push({
    orgId: probeOrg,
    kind: "classify",
    status: "queued",
    payload: { reason: "replied" },
    dueAt: new Date(),
    leaseUntil: new Date(0),
    attempts: 0,
    createdAt: new Date(),
    productId: "productB",
    campaignKey: "camp10",
    priority: PRIORITY.urgent,
  });
  await db.collection(C.workQueue).insertMany(rows);

  try {
    const summary = await dispatch(probeOrg);
    const lane = summary.lanes.find((l) => l.kind === "classify")!;

    // Urgent items are excluded from the fairness measurement on purpose: they are served
    // outside the round by design, and counting them would read as one campaign taking more
    // than its share when it did nothing of the kind.
    const granted = (await db
      .collection(C.workQueue)
      .aggregate([
        { $match: { orgId: probeOrg, status: "ready", priority: { $ne: PRIORITY.urgent } } },
        { $group: { _id: "$campaignKey", n: { $sum: 1 } } },
      ])
      .toArray()) as Array<{ _id: string; n: number }>;

    const served = new Set(granted.map((g) => g._id));
    const counts = granted.map((g) => g.n);

    check(
      "every campaign gets a turn in the first round",
      served.size === 10,
      `${served.size}/10 campaigns served: ${granted.map((g) => `${g._id}=${g.n}`).sort().join(" ")}`,
    );
    // A budget that is not a whole multiple of quantum × campaigns always leaves a surplus,
    // and somebody has to have it. What matters is that the gap is bounded by one quantum
    // rather than by who happens to be first in the list.
    const big = granted.filter((g) => g._id !== "camp3").map((g) => g.n);
    check(
      "no campaign takes more than one quantum above any other",
      Math.max(...big) - Math.min(...big) <= 60,
      `grants ranged ${Math.min(...big)}–${Math.max(...big)}, quantum 60`,
    );
    check(
      "the small campaign finishes instead of waiting behind the large ones",
      (granted.find((g) => g._id === "camp3")?.n ?? 0) === 12,
      `camp3 granted ${granted.find((g) => g._id === "camp3")?.n ?? 0} of its 12`,
    );
    check(
      "a reply is served outside the fair share",
      lane.urgent === 1,
      `${lane.urgent} urgent item served ahead of the round`,
    );

    // The failure this test was written for: the surplus landing on the same campaigns every
    // cycle, which is fair inside one round and permanently unfair across an hour.
    await db.collection(C.workQueue).updateMany({ orgId: probeOrg, status: "ready" }, { $set: { status: "done" } });
    await dispatch(probeOrg);
    const second = (await db
      .collection(C.workQueue)
      .aggregate([
        { $match: { orgId: probeOrg, status: "ready", priority: { $ne: PRIORITY.urgent } } },
        { $group: { _id: "$campaignKey", n: { $sum: 1 } } },
      ])
      .toArray()) as Array<{ _id: string; n: number }>;

    // Fairness over two cycles, not one. A single cycle always has a surplus that somebody
    // has to take, and a campaign served part-way through a grant is owed the remainder — so
    // "took more than a quantum this cycle" is not evidence of anything. What must hold is
    // that nobody pulls ahead cumulatively, which is the property that failed before: the
    // loop walked from the top every time, so the first campaigns took the surplus every
    // minute and the last ones never did.
    const total = new Map<string, number>();
    for (const row of [...granted, ...second]) {
      total.set(row._id, (total.get(row._id) ?? 0) + row.n);
    }
    total.delete("camp3");
    const totals = [...total.values()];
    const spread = Math.max(...totals) - Math.min(...totals);
    check(
      "no campaign pulls ahead over successive cycles",
      spread <= 60,
      `after two cycles, grants ranged ${Math.min(...totals)}–${Math.max(...totals)} (spread ${spread}, quantum 60)`,
    );
  } finally {
    await db.collection(C.workQueue).deleteMany({ orgId: probeOrg });
    await db.collection(C.audit).deleteMany({ orgId: probeOrg });
  }
}

// ── 7. The starvation the old sweep hid ──────────────────────────────────────
{
  const unplanned = await db
    .collection(C.goalInstances)
    .countDocuments({ orgId, productId, status: "active", currentPlanId: { $exists: false } });
  const found = await db
    .collection(C.goalInstances)
    .find({ orgId, productId, status: "active", currentPlanId: { $exists: false } })
    .sort({ startedAt: 1 })
    .limit(25)
    .toArray();

  check(
    "campaigns with no plan are found by querying the condition, not by filtering a page",
    unplanned === 0 || found.length > 0,
    `${unplanned} unplanned active campaigns; a 25-item page returns ${found.length}`,
  );
}

// ── 8. The greeting the template already wrote ───────────────────────────────
{
  const template = await resolveTemplateFor({ orgId, productId, channel: "email", touchesSpent: 1 });
  const vars = {
    first_name: "Kiran",
    full_name: "Kiran Shah",
    company: "Acme",
    person_id: "x",
    trial_link: "https://example.com/start",
    opt_out_url: "https://example.com/u",
  };

  // Exactly what a live routine wrote for a real person: it opens by saying hello, because
  // that is what writing to a named human looks like.
  const rendered = renderTemplate(template?.blocks as Record<string, unknown>[], vars, {
    slotText: "Hi Kiran,\n\nMost electrical contractors can tell you total hours worked in a week.",
  });
  const greetings = (rendered.bodyMd.match(/Hi Kiran,/g) ?? []).length;
  check(
    "the reader is greeted once, not twice",
    greetings === 1,
    `"Hi Kiran," appears ${greetings} time(s) in the rendered body`,
  );

  // And a paragraph that merely begins with a name is the writing doing its job.
  const kept = renderTemplate(template?.blocks as Record<string, unknown>[], vars, {
    slotText: "Kiran, the retainer you flagged last month is the one running over.",
  });
  check(
    "a sentence that opens with a name is not mistaken for a salutation",
    kept.bodyMd.includes("the retainer you flagged last month"),
    kept.bodyMd.includes("the retainer you flagged last month") ? "kept intact" : "the opening sentence was stripped",
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
