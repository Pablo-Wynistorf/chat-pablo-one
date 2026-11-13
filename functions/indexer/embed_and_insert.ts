/**
 * Local CLI for the index sync (the deployed indexer Lambda runs the same code,
 * see src/index.ts and lib/sync.ts).
 *
 *   npm run index              # embed new/edited chunks, prune stale vectors
 *   npm run index:dry-run      # read-only report + cost estimate
 *   npm run index -- --force   # re-embed everything
 *
 * Reads VECTOR_BUCKET / VECTOR_INDEX / BEDROCK_MODEL_ID from .env.local in this
 * folder (or the environment) and uses your local AWS credentials.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncError, syncIndex } from "./lib/sync.js";

const HERE = dirname(fileURLToPath(import.meta.url));

syncIndex({
  dataDir: join(HERE, "data"),
  dryRun: process.argv.includes("--dry-run"),
  force: process.argv.includes("--force"),
}).catch((err: unknown) => {
  console.error(err instanceof SyncError ? `\n✖ ${err.message}\n` : "Index failed:", err instanceof SyncError ? "" : err);
  process.exit(1);
});
