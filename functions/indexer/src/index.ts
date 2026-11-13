/**
 * Indexer Lambda: keeps the S3 Vectors index in sync with the chunk files that
 * are bundled into this deployment package (data/*.json, copied to dist/data by
 * the build).
 *
 * Terraform handler: "index.handler" (dist/index.mjs at the package root).
 * Triggered by an EventBridge schedule on the "live" alias (terraform/functions.tf),
 * so a newly deployed version with new data is loaded on the next tick. It can
 * also be invoked by hand:
 *
 *   aws lambda invoke --function-name <indexer_function_name>:live \
 *     --cli-binary-format raw-in-base64-out --payload '{"dryRun":true}' out.json
 *
 * Idempotent by design: every vector carries a content hash, unchanged chunks are
 * skipped, so a run with nothing new costs no Bedrock tokens. Two versions running
 * side by side during a deploy converge on whichever data set ran last.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncIndex, type SyncSummary } from "../lib/sync.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

interface IndexerEvent {
  /** Manual invokes only: report what would change without writing. */
  dryRun?: boolean;
  /** Manual invokes only: re-embed every chunk. */
  force?: boolean;
}

export async function handler(event: IndexerEvent | undefined): Promise<SyncSummary> {
  const summary = await syncIndex({
    dataDir: DATA_DIR,
    dryRun: event?.dryRun === true,
    force: event?.force === true,
  });
  console.log(JSON.stringify({ msg: "index sync finished", ...summary }));
  return summary;
}
