import { routineCatalog } from "../engine/routines.js";

/**
 * The prompt each routine runs, as the code builds it.
 *
 * The six routines run on claude.ai as remote triggers holding a copy of these words, so a
 * prompt edited here is not live until it is pushed. This prints them for that comparison:
 *
 *   npm run prompts -- <productId>             every routine
 *   npm run prompts -- <productId> advance     one of them, ready to diff against the trigger
 */
function main(): void {
  const productId = process.argv[2];
  const only = process.argv[3];
  if (!productId) throw new Error("Pass a productId: npm run prompts -- <productId> [routine]");
  for (const routine of routineCatalog(productId)) {
    if (only && routine.key !== only) continue;
    if (!only) process.stdout.write(`===== ${routine.key} (${routine.cron ?? "no cron"}) =====\n`);
    process.stdout.write(`${routine.prompt}\n`);
  }
}

main();
