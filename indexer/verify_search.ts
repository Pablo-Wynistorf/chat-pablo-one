/**
 * Quick end-to-end sanity check: embed a few queries and print the top page
 * matches from S3 Vectors. Not part of the normal flow — just for verifying the
 * index after `npm run index`.
 *
 *   npx tsx verify_search.ts "AWS certifications" "worldskills"
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { QueryVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";
import { credentials, region, requireEnv } from "./lib/aws.js";

const VECTOR_BUCKET = requireEnv("VECTOR_BUCKET");
const VECTOR_INDEX = requireEnv("VECTOR_INDEX");
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "amazon.titan-embed-text-v2:0";

const creds = credentials();
const bedrock = new BedrockRuntimeClient({ region, credentials: creds });
const s3v = new S3VectorsClient({ region, credentials: creds });

async function embed(text: string): Promise<number[]> {
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: 1024, normalize: true }),
    }),
  );
  return (JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] }).embedding;
}

async function run(query: string): Promise<void> {
  const embedding = await embed(query);
  const res = await s3v.send(
    new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: VECTOR_INDEX,
      queryVector: { float32: embedding },
      topK: 20,
      returnMetadata: true,
      returnDistance: true,
    }),
  );

  const best = new Map<string, { score: number; title: string }>();
  for (const v of res.vectors ?? []) {
    const m = v.metadata as unknown as { url?: string; title?: string } | undefined;
    if (!m?.url) continue;
    const score = Math.max(0, Math.min(1, 1 - (v.distance ?? 1)));
    const prev = best.get(m.url);
    if (!prev || score > prev.score) best.set(m.url, { score, title: m.title ?? "" });
  }

  console.log(`\n🔎 "${query}"`);
  [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5)
    .forEach(([url, { score, title }]) =>
      console.log(`  ${(score * 100).toFixed(0)}%  ${title}\n        ${url}`),
    );
}

async function main(): Promise<void> {
  const queries =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : ["AWS certifications", "worldskills competition", "music festival networking", "who is Pablo"];
  for (const q of queries) await run(q);
}

main().catch((err) => {
  console.error("verify failed:", err);
  process.exit(1);
});
