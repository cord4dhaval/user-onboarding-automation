/**
 * sameSteps — the guard that stops a playbook stamp from writing an identical plan version.
 *
 *   npx tsx src/scripts/verify-same-steps.ts
 */
import { sameSteps } from "../engine/playbooks";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

const base = [
  { id: 1, offsetDays: 0, channel: "email", angle: "intro_variant_2", why: "a" },
  { id: 2, offsetDays: 3, channel: "email", angle: "book_call", why: "b", gate: "warm" },
];
check("identical steps → same", sameSteps(base, base.map((s) => ({ ...s }))));
check("wording of why does not matter", sameSteps(base, base.map((s) => ({ ...s, why: "rewritten" }))));
check("different angle → different", !sameSteps(base, [base[0], { ...base[1], angle: "last_call" }]));
check("different offset → different", !sameSteps(base, [base[0], { ...base[1], offsetDays: 5 }]));
check("different gate → different", !sameSteps(base, [base[0], { ...base[1], gate: "cold" }]));
check("extra step → different", !sameSteps(base, [...base, base[0]]));
check("order matters", !sameSteps(base, [base[1], base[0]]));
check("session plan after_days vs playbook offsetDays compares the number", sameSteps(
  [{ id: 1, after_days: 3, channel: "email", angle: "x" }],
  [{ id: 1, offsetDays: 3, channel: "email", angle: "x" }],
));
check("non-arrays → different", !sameSteps(undefined, base));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
