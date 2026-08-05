import { QueryVectorsCommand } from "@aws-sdk/client-s3vectors";
import type { DocumentType } from "@smithy/types";
import { s3vClient } from "./aws";
import { embed } from "./bedrock";
import type { ChunkMatch, PageMetadata, PageResult } from "./types";

export interface SearchOptions {
  /** Number of pages to return after de-duplication. Defaults to 8. */
  topPages?: number;
  /** Drop results below this similarity (0..1). Defaults to MIN_SCORE env or 0.25. */
  minScore?: number;
}

// A vector search always returns the topK nearest neighbours, even weak ones.
// This floor makes "no real match" render as empty instead of listing loosely
// related pages. Tune via MIN_SCORE in web/.env.local.
const DEFAULT_MIN_SCORE = Number.parseFloat(process.env.MIN_SCORE ?? "0.25");

// The index stores one vector per page-chunk, so a single page can have several
// vectors. Over-fetch chunks, then collapse to the best chunk per URL.
const CHUNK_TOPK = 30;

/**
 * Convert an S3 Vectors cosine distance into a [0, 1] similarity score.
 * For the cosine metric, distance = 1 - cosineSimilarity, so similarity is
 * simply 1 - distance (clamped for safety against float drift).
 */
function distanceToScore(distance: number | undefined): number {
  if (distance === undefined || Number.isNaN(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance));
}

/**
 * Low-level retrieval: embed the query and return the nearest page-chunks with
 * their full stored passage. Both the search dashboard and the RAG chatbot
 * build on this.
 */
export async function queryChunks(
  query: string,
  topK = CHUNK_TOPK,
  /**
   * Optional S3 Vectors metadata filter, e.g. `{ section: { $ne: "code" } }`.
   * Filtering happens during the search rather than after it, so a filtered
   * query still returns a full top-K from the matching subset.
   */
  filter?: DocumentType,
): Promise<ChunkMatch[]> {
  const embedding = await embed(query);

  const res = await s3vClient.send(
    new QueryVectorsCommand({
      vectorBucketName: process.env.VECTOR_BUCKET!,
      indexName: process.env.VECTOR_INDEX!,
      queryVector: { float32: embedding },
      topK,
      returnMetadata: true,
      returnDistance: true,
      ...(filter ? { filter } : {}),
    }),
  );

  const matches: ChunkMatch[] = [];
  for (const v of res.vectors ?? []) {
    const meta = v.metadata as unknown as PageMetadata | undefined;
    if (!meta?.url) continue;
    const match: ChunkMatch = {
      url: meta.url,
      title: meta.title,
      description: meta.description,
      section: meta.section,
      chunkIndex: meta.chunkIndex,
      text: meta.text,
      score: distanceToScore(v.distance),
    };
    if (meta.repo) match.repo = meta.repo;
    if (meta.path) match.path = meta.path;
    if (meta.language) match.language = meta.language;
    matches.push(match);
  }
  return matches;
}

/** Truncate a passage to a compact snippet for result cards. */
function snippet(text: string): string {
  const t = (text ?? "").trim();
  return t.length > 300 ? `${t.slice(0, 297).trimEnd()}...` : t;
}

/**
 * Semantic search over the crawled website. Returns ranked pages, each pointing
 * to the URL where the best-matching passage lives.
 */
export async function searchSite(
  query: string,
  opts?: SearchOptions,
): Promise<PageResult[]> {
  const matches = await queryChunks(query);
  const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;
  const topPages = opts?.topPages ?? 8;

  // Collapse chunks to one entry per page, keeping the highest-scoring chunk.
  const bestByUrl = new Map<string, PageResult>();
  for (const m of matches) {
    if (m.score < minScore) continue;
    const existing = bestByUrl.get(m.url);
    if (!existing || m.score > existing.score) {
      bestByUrl.set(m.url, {
        url: m.url,
        title: m.title,
        description: m.description,
        section: m.section,
        score: m.score,
        snippet: snippet(m.text),
      });
    }
  }

  return [...bestByUrl.values()].sort((a, b) => b.score - a.score).slice(0, topPages);
}
