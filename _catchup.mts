import { runSource } from "./src/engine/runSource.js";

// One ingest through the real production path — same code the clock calls.
const summary = await runSource("6a994a34b4793622de24286c");
console.log(JSON.stringify(summary, null, 1));
process.exit(0);
