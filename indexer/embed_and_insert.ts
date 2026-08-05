/**
 * Embeds every crawled page-chunk via Bedrock Titan Embed Text v2 and inserts
 * the vectors into the S3 Vectors index.
 *
 *   npm run index
 *
 * Requires: `npm run crawl` first, Terraform applied, and Bedrock model access
 * enabled for amazon.titan-embed-text-v2:0 in the target region.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DeleteVectorsCommand,
  ListVectorsCommand,
  PutVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials, region, requireEnv } from "./lib/aws.js";
import { mapPool } from "./lib/pool.js";
import { withRetry } from "./lib/retry.js";
import type { Chunk } from "./lib/chunk.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");

const DRY_RUN = process.argv.includes("--dry-run");
/**
 * Re-embed everything, ignoring the stored hashes. An escape hatch for when the
 * embeddings are suspect but the content hasn't changed — normally unnecessary,
 * since a different model id already invalidates every hash on its own.
 */
const FORCE = process.argv.includes("--force");

const EMBED_CONCURRENCY = 8;
const PUT_BATCH_SIZE = 500;
const EMBED_DIMENSION = 1024;

/**
 * Titan Text Embeddings V2 on-demand price per 1K input tokens, by region.
 * These differ by an order of magnitude — us-east-1 is $0.00002 while
 * eu-central-1 is $0.0002 — so a single hardcoded constant reports the wrong
 * number by 10x for this project's default region.
 */
const USD_PER_1K_TOKENS_BY_REGION: Record<string, number> = {
  "us-east-1": 0.00002,
  "us-east-2": 0.00002,
  "us-west-2": 0.00002,
  "eu-central-1": 0.0002,
  "eu-central-2": 0.000027,
  "eu-west-2": 0.0001,
};
const USD_PER_1K_TOKENS = USD_PER_1K_TOKENS_BY_REGION[region] ?? 0.0002;

// S3 Vectors, eu-central-1. Used for the pre-flight estimate only.
const USD_PER_GB_PUT = 0.214;
const USD_PER_GB_MONTH = 0.064;

interface TitanResponse {
  embedding: number[];
  inputTextTokenCount: number;
}

const VECTOR_BUCKET = requireEnv("VECTOR_BUCKET");
const VECTOR_INDEX = requireEnv("VECTOR_INDEX");
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "amazon.titan-embed-text-v2:0";

const creds = credentials();
const bedrock = new BedrockRuntimeClient({ region, credentials: creds });
const s3v = new S3VectorsClient({ region, credentials: creds });

// Prefix the embedded text with the title so short pages still carry topical
// signal, and the passage itself provides the fine-grained match.
function embedText(chunk: Chunk): string {
  return `${chunk.title}\n\n${chunk.text}`;
}

/**
 * Metadata key holding the content fingerprint of an indexed chunk.
 *
 * Filterable (i.e. NOT in the index's non_filterable_metadata_keys), which is
 * deliberate: adding a key to that list changes `metadata_configuration`, and
 * that forces replacement of the whole index — destroying every vector to save
 * re-embedding them, which is precisely backwards.
 */
const HASH_KEY = "contentHash";

/**
 * Fingerprint of everything about a chunk that would make its stored vector
 * wrong: the text that gets embedded, the passage and metadata that get stored,
 * and the embedding model itself. Change the model and every hash changes, so a
 * model swap re-embeds the corpus automatically rather than silently leaving a
 * mix of incompatible vectors in one index.
 *
 * Truncated to 16 hex chars (64 bits). Collisions are not a practical concern at
 * a few thousand chunks, and the value rides in each vector's metadata, where
 * S3 Vectors caps filterable metadata per vector.
 */
function chunkHash(chunk: Chunk, model: string): string {
  const parts = [
    model,
    embedText(chunk),
    passage(chunk),
    chunk.url,
    chunk.title,
    chunk.description,
    chunk.section,
    String(chunk.chunkIndex),
    chunk.repo ?? "",
    chunk.path ?? "",
    chunk.language ?? "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function isAccessDenied(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return name === "AccessDeniedException" || name === "AccessDenied";
}

async function embedOne(chunk: Chunk): Promise<{ embedding: number[]; tokens: number }> {
  const body = JSON.stringify({
    inputText: embedText(chunk),
    dimensions: EMBED_DIMENSION,
    normalize: true,
  });

  const res = await withRetry(
    () =>
      bedrock.send(
        new InvokeModelCommand({
          modelId: MODEL_ID,
          contentType: "application/json",
          accept: "application/json",
          body,
        }),
      ),
    {
      onRetry: (attempt, delayMs) =>
        console.warn(`  throttled, retry ${attempt} in ${delayMs}ms`),
    },
  );

  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as TitanResponse;
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBED_DIMENSION) {
    throw new Error(
      `Unexpected embedding shape for ${chunk.id}: got length ${parsed.embedding?.length}`,
    );
  }
  return { embedding: parsed.embedding, tokens: parsed.inputTextTokenCount ?? 0 };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Every vector currently in the index, mapped key -> stored content hash.
 *
 * This is the record of what has already been indexed, and it lives in the index
 * itself rather than in a manifest file or Terraform state. That matters: a side
 * file can drift from reality (deleted, stale, or from a different bucket) and
 * would then either re-embed everything or — worse — skip chunks that aren't
 * actually there. The index cannot disagree with itself.
 *
 * A vector indexed before content hashing existed has no hash, comes back
 * undefined, and is treated as needing a refresh.
 */
async function listExisting(): Promise<Map<string, string | undefined>> {
  const existing = new Map<string, string | undefined>();
  let nextToken: string | undefined;
  do {
    const res = await withRetry(() =>
      s3v.send(
        new ListVectorsCommand({
          vectorBucketName: VECTOR_BUCKET,
          indexName: VECTOR_INDEX,
          maxResults: 500,
          returnMetadata: true,
          nextToken,
        }),
      ),
    ).catch((err: unknown) => {
      // An index that exists but is empty returns an empty list, so a 404 here
      // means the index genuinely isn't there — wrong name, or it was deleted
      // out of band. Fail loudly rather than silently treating it as empty and
      // re-embedding the whole corpus into nothing.
      if ((err as { name?: string })?.name === "NotFoundException") {
        throw new Error(
          `Vector index "${VECTOR_INDEX}" not found in bucket "${VECTOR_BUCKET}" (${region}).\n` +
            `  Either the names are wrong, or the index no longer exists.\n` +
            `  Check with: aws s3vectors list-indexes --vector-bucket-name ${VECTOR_BUCKET} --region ${region}\n` +
            `  Recreate it with: cd terraform && terraform apply`,
        );
      }
      throw err;
    });
    for (const v of res.vectors ?? []) {
      if (!v.key) continue;
      const meta = v.metadata as Record<string, unknown> | undefined;
      const hash = meta?.[HASH_KEY];
      existing.set(v.key, typeof hash === "string" ? hash : undefined);
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return existing;
}

interface Plan {
  /** Chunks that must be embedded and written: new, edited, or never hashed. */
  toWrite: Chunk[];
  /** Chunks already in the index with a matching hash — skipped entirely. */
  unchanged: number;
  /** Keys in the index that the current data set no longer produces. */
  stale: string[];
  /** Existing vectors with no stored hash, i.e. indexed before hashing existed. */
  unhashed: number;
}

/** Diff the chunks on disk against what the index already holds. */
function planWork(chunks: Chunk[], existing: Map<string, string | undefined>): Plan {
  const toWrite: Chunk[] = [];
  let unchanged = 0;
  let unhashed = 0;

  for (const chunk of chunks) {
    const stored = existing.get(chunk.id);
    if (stored === undefined) {
      // Either absent from the index, or present but never hashed.
      if (existing.has(chunk.id)) unhashed += 1;
      toWrite.push(chunk);
      continue;
    }
    if (stored === chunkHash(chunk, MODEL_ID)) {
      unchanged += 1;
      continue;
    }
    toWrite.push(chunk);
  }

  return { toWrite, unchanged, stale: staleKeys(chunks, existing), unhashed };
}

/** Keys present in the index that the current data set no longer produces. */
function staleKeys(chunks: Chunk[], existing: Map<string, string | undefined>): string[] {
  const current = new Set(chunks.map((c) => c.id));
  return [...existing.keys()].filter((k) => !current.has(k));
}

/** `--force`: treat every chunk as needing a write, but still prune correctly. */
function forceAll(chunks: Chunk[], existing: Map<string, string | undefined>): Plan {
  return {
    toWrite: chunks,
    unchanged: 0,
    unhashed: 0,
    stale: staleKeys(chunks, existing),
  };
}

/**
 * Keep the index in exact sync with data/: delete leftover vectors whose keys are
 * no longer produced (e.g. removed pages, or keys from an older id scheme). Runs
 * after the writes so the index is never left empty.
 */
async function pruneStale(stale: string[]): Promise<void> {
  if (stale.length === 0) {
    console.log("No stale vectors to prune.");
    return;
  }
  for (const batch of chunkArray(stale, PUT_BATCH_SIZE)) {
    await withRetry(() =>
      s3v.send(
        new DeleteVectorsCommand({
          vectorBucketName: VECTOR_BUCKET,
          indexName: VECTOR_INDEX,
          keys: batch,
        }),
      ),
    );
  }
  console.log(`Pruned ${stale.length} stale vector(s).`);
}

/** Load and merge every `data/*.json` chunk file produced by the ingest scripts. */
function loadChunks(): Chunk[] {
  if (!existsSync(DATA_DIR)) return [];
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const all: Chunk[] = [];
  const bySource: Record<string, number> = {};
  for (const file of files) {
    const chunks = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as Chunk[];
    bySource[file] = chunks.length;
    all.push(...chunks);
  }
  for (const [file, n] of Object.entries(bySource)) {
    console.log(`  ${file}: ${n} chunks`);
  }
  // Guard against duplicate keys across sources (S3 Vectors would upsert).
  const seen = new Set<string>();
  const deduped = all.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  if (deduped.length !== all.length) {
    console.warn(`  (dropped ${all.length - deduped.length} duplicate keys)`);
  }
  return deduped;
}

const MAX_PROSE_CHARS = 2000;
// Code chunks are line-capped at ~3,200 chars upstream; store the whole thing so
// the model never sees a function cut off mid-body. S3 Vectors allows 40KB of
// metadata per vector, so this is still far inside the limit.
const MAX_CODE_CHARS = 3600;

/**
 * Store the full passage (non-filterable metadata) so the RAG chatbot has real
 * context to ground its answers on.
 *
 * Prose gets its whitespace collapsed; code must NOT — indentation and line
 * breaks are what make a snippet readable, and flattening them would leave the
 * model reasoning about a single 3,000-character line.
 */
function passage(chunk: Chunk): string {
  const isCode = chunk.section === "code";
  const limit = isCode ? MAX_CODE_CHARS : MAX_PROSE_CHARS;

  const t = isCode
    ? chunk.text.replace(/[ \t]+$/gm, "").trim()
    : chunk.text.trim().replace(/\s+/g, " ");

  return t.length > limit ? `${t.slice(0, limit - 3).trimEnd()}...` : t;
}

/** Approximate token count (~3.6 chars/token for source code, ~4.2 for prose). */
function estimateTokens(chunk: Chunk): number {
  return Math.ceil(embedText(chunk).length / (chunk.section === "code" ? 3.6 : 4.2));
}

/** Logical vector size — data + key + metadata, which is what S3 Vectors bills. */
function logicalBytes(chunk: Chunk): number {
  const meta =
    passage(chunk).length +
    chunk.url.length +
    chunk.title.length +
    chunk.description.length +
    chunk.section.length +
    (chunk.repo?.length ?? 0) +
    (chunk.path?.length ?? 0) +
    (chunk.language?.length ?? 0) +
    HASH_KEY.length +
    16;
  return EMBED_DIMENSION * 4 + chunk.id.length + meta;
}

/**
 * Pre-flight report. Reads the index (a handful of paginated ListVectors calls,
 * effectively free) so the estimate reflects the work that would ACTUALLY happen
 * rather than the cost of a full re-embed.
 */
function estimate(chunks: Chunk[], plan: Plan): void {
  const bySection: Record<string, number> = {};
  let totalBytes = 0;
  for (const chunk of chunks) {
    bySection[chunk.section] = (bySection[chunk.section] ?? 0) + 1;
    totalBytes += logicalBytes(chunk);
  }

  const writeTokens = plan.toWrite.reduce((n, c) => n + estimateTokens(c), 0);
  const writeGb = plan.toWrite.reduce((n, c) => n + logicalBytes(c), 0) / 1024 ** 3;
  const totalGb = totalBytes / 1024 ** 3;

  const embedCost = (writeTokens / 1000) * USD_PER_1K_TOKENS;
  const putCost = writeGb * USD_PER_GB_PUT;
  const storageCost = totalGb * USD_PER_GB_MONTH;

  console.log("──────────── DRY RUN (read-only) ────────────");
  for (const [section, n] of Object.entries(bySection).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${section.padEnd(10)} ${n} chunks`);
  }
  console.log(`\nChunks on disk    : ${chunks.length.toLocaleString()}`);
  console.log(`Already indexed   : ${plan.unchanged.toLocaleString()} (skipped)`);
  console.log(`To embed + write  : ${plan.toWrite.length.toLocaleString()}`);
  if (plan.unhashed > 0) {
    console.log(`  ...of which ${plan.unhashed.toLocaleString()} are indexed but unhashed`);
  }
  console.log(`Stale to delete   : ${plan.stale.length.toLocaleString()}`);
  console.log(`Logical size      : ${(totalGb * 1024).toFixed(1)} MB total`);
  console.log(`\nRegion            : ${region} @ $${USD_PER_1K_TOKENS}/1K tokens`);
  console.log(`Embeddings        : ~$${embedCost.toFixed(4)}  (${writeTokens.toLocaleString()} tokens)`);
  console.log(`S3 Vectors PUT    : ~$${putCost.toFixed(4)}`);
  console.log(`S3 Vectors store  : ~$${storageCost.toFixed(4)} / month`);
  console.log(`\nTHIS RUN WOULD COST: ~$${(embedCost + putCost).toFixed(4)}`);
  console.log("─────────────────────────────────────────────");
  console.log(
    plan.toWrite.length === 0 && plan.stale.length === 0
      ? "Index is already up to date; a real run would do nothing."
      : "Run without --dry-run to apply.",
  );
}

async function main(): Promise<void> {
  console.log("Loading chunks from data/:");
  let chunks: Chunk[];
  try {
    chunks = loadChunks();
  } catch (err) {
    console.error("Failed to read data/*.json:", err);
    process.exit(1);
  }

  if (chunks.length === 0) {
    console.error(
      "\nNo chunks found in data/. Run at least one ingest step first:\n" +
        "  npm run crawl            # website\n" +
        "  npm run ingest:github    # GitHub repos\n" +
        "  npm run ingest:docs      # curated docs (LinkedIn, background)\n",
    );
    process.exit(1);
  }
  console.log("");

  // What's already in the index decides how much work there is to do.
  console.log(`Reading current index state from ${VECTOR_BUCKET}/${VECTOR_INDEX}…`);
  const existing = await listExisting();
  const plan = FORCE ? forceAll(chunks, existing) : planWork(chunks, existing);

  console.log(
    `  ${existing.size} vector(s) in index · ${plan.unchanged} unchanged · ` +
      `${plan.toWrite.length} to write · ${plan.stale.length} stale\n`,
  );

  if (DRY_RUN) {
    estimate(chunks, plan);
    return;
  }

  if (plan.toWrite.length === 0 && plan.stale.length === 0) {
    console.log("Index already matches data/. Nothing to embed — $0.00 spent.");
    return;
  }

  console.log(
    `Indexing ${plan.toWrite.length} chunk(s) into ${VECTOR_BUCKET}/${VECTOR_INDEX} (${region})\n`,
  );

  let embedded = 0;
  let totalTokens = 0;
  let embeddings: Array<{ embedding: number[]; tokens: number }>;
  try {
    embeddings = await mapPool(plan.toWrite, EMBED_CONCURRENCY, async (chunk) => {
      const r = await embedOne(chunk);
      embedded += 1;
      totalTokens += r.tokens;
      if (embedded % 10 === 0 || embedded === plan.toWrite.length) {
        console.log(`  embedded ${embedded}/${plan.toWrite.length}`);
      }
      return r;
    });
  } catch (err) {
    if (isAccessDenied(err)) {
      console.error(
        `\n✖ AccessDeniedException from Bedrock.\n\n` +
          `  The model "${MODEL_ID}" is not enabled for this account/region (${region}).\n` +
          `  Fix: AWS Console → Bedrock → Model access → enable "Titan Text Embeddings V2"\n` +
          `  in ${region}, wait a minute, then re-run \`npm run index\`.\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  const vectors = plan.toWrite.map((chunk, i) => {
    // Only `title`/`text`/`description` are non-filterable (see terraform).
    // repo/path/language land in filterable metadata, so the app can scope a
    // query to one project or one file later on.
    const metadata: Record<string, string | number> = {
      url: chunk.url,
      title: chunk.title,
      description: chunk.description,
      section: chunk.section,
      chunkIndex: chunk.chunkIndex,
      text: passage(chunk),
      // The fingerprint that lets the next run skip this chunk.
      [HASH_KEY]: chunkHash(chunk, MODEL_ID),
    };
    if (chunk.repo) metadata.repo = chunk.repo;
    if (chunk.path) metadata.path = chunk.path;
    if (chunk.language) metadata.language = chunk.language;

    return { key: chunk.id, data: { float32: embeddings[i]!.embedding }, metadata };
  });

  let inserted = 0;
  for (const batch of chunkArray(vectors, PUT_BATCH_SIZE)) {
    await withRetry(() =>
      s3v.send(
        new PutVectorsCommand({
          vectorBucketName: VECTOR_BUCKET,
          indexName: VECTOR_INDEX,
          vectors: batch,
        }),
      ),
    );
    inserted += batch.length;
    console.log(`  inserted ${inserted}/${vectors.length}`);
  }

  // Keep the index in exact sync with the current data set.
  await pruneStale(plan.stale);

  const estCost = (totalTokens / 1000) * USD_PER_1K_TOKENS;
  console.log("\n──────────────────────────────────────────────");
  console.log(`Chunks on disk         : ${chunks.length}`);
  console.log(`Skipped (unchanged)    : ${plan.unchanged}`);
  console.log(`Embedded + written     : ${inserted}`);
  console.log(`Stale deleted          : ${plan.stale.length}`);
  console.log(`Total Bedrock tokens   : ${totalTokens.toLocaleString()}`);
  console.log(
    `Estimated Bedrock cost : ~$${estCost.toFixed(5)} (Titan v2 @ $${USD_PER_1K_TOKENS}/1K tokens in ${region})`,
  );
  console.log("──────────────────────────────────────────────");
  console.log("Done. Start the app with:  cd web && npm run dev");
}

main().catch((err) => {
  console.error("Index failed:", err);
  process.exit(1);
});
