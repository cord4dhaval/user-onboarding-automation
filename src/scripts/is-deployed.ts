import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";

/**
 * Whether production is actually running the code in this working tree.
 *
 * Pushing is not deploying, and the difference has been invisible here more than once: a
 * commit sat on GitHub for half an hour while the running app kept sending mail with the
 * old code, and the only symptom was messages failing for a reason that had already been
 * fixed. Asking the deployment directly is the only answer worth trusting.
 *
 * The test is a page chunk rather than a version string, because a chunk's name is a hash
 * of its contents: if the deployment serves the file this build produced, it is running
 * this build. Vendor chunks are no use for this — they are identical across commits that
 * do not touch dependencies — so it uses a page that changes.
 *
 *   npm run build:check && npm run is:deployed
 */

/**
 * The deployed app, not whatever APP_URL happens to point at locally — a .env aimed at
 * localhost would have this cheerfully reporting on the dev server it was run beside.
 */
const APP_URL = (process.env.DEPLOY_URL ?? "https://user-onboarding-automation-oryc.vercel.app").replace(/\/$/, "");
const DIST = process.env.NEXT_DIST_DIR ?? ".next-check";
/** A page edited often enough to differ between builds. */
const PAGE = "app/products/[id]/review";

const head = execSync("git rev-parse --short HEAD").toString().trim();
const remote = execSync("git ls-remote origin -h refs/heads/main").toString().slice(0, 7);

let chunks: string[];
try {
  chunks = readdirSync(`${DIST}/static/chunks/${PAGE}`);
} catch {
  console.log(`no build found in ${DIST}. Run: npm run build:check`);
  process.exit(2);
}

console.log(`\nworking tree  ${head}`);
console.log(`github main   ${remote} ${remote.startsWith(head) ? "" : "← not the same commit; push first"}`);

let live = false;
for (const file of chunks) {
  const url = `${APP_URL}/_next/static/chunks/${encodeURIComponent(PAGE).replace(/%2F/g, "/")}/${file}`;
  const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
  if (res.ok) live = true;
}

console.log(
  live
    ? `production    running this build ✅  ${APP_URL}\n`
    : `production    NOT this build ❌  ${APP_URL}\n              the deployment is serving older code — check Vercel\n`,
);
process.exit(live ? 0 : 1);
