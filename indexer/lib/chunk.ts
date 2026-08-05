/**
 * Shared document model + chunking used by every ingestion source
 * (website crawl, GitHub repos, curated markdown docs). Each source produces an
 * array of `Chunk`s written to `data/<source>.json`; `embed_and_insert.ts` then
 * embeds and inserts every chunk from every source into the one S3 Vectors index.
 */

export type Section = "website" | "github" | "code" | "linkedin" | "about" | string;

export interface Chunk {
  /** Stable, globally-unique key across all sources, e.g. "github:aws-nuke#0". */
  id: string;
  /** Canonical link to where this content lives (page / repo / profile / file). */
  url: string;
  title: string;
  description: string;
  /** Which source/kind this came from — also used as a result badge + filter. */
  section: Section;
  chunkIndex: number;
  chunkCount: number;
  /** The passage that gets embedded and later fed to the RAG model. */
  text: string;
  /** Repo name, for source-code chunks (section "code"). */
  repo?: string;
  /** Repo-relative file path, e.g. "indexer/lib/chunk.ts". */
  path?: string;
  /** Human language label, e.g. "TypeScript". */
  language?: string;
}

export interface ChunkOptions {
  words?: number;
  overlap?: number;
}

const DEFAULT_WORDS = 220;
const DEFAULT_OVERLAP = 40;

/** Split text into overlapping word-windows. Small inputs return a single chunk. */
export function chunkWords(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.words ?? DEFAULT_WORDS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words.length <= size) return [words.join(" ")];

  const chunks: string[] = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + size).join(" "));
    if (start + size >= words.length) break;
  }
  return chunks;
}

export interface ChunkMeta {
  keyPrefix: string;
  url: string;
  title: string;
  description: string;
  section: Section;
  repo?: string;
  path?: string;
  language?: string;
}

/**
 * Attach stable keys and shared metadata to passages that were already split by
 * a source-specific splitter (e.g. the line-aligned code chunker).
 */
export function fromPieces(meta: ChunkMeta, pieces: string[]): Chunk[] {
  return pieces.map((text, i) => {
    const chunk: Chunk = {
      id: `${meta.keyPrefix}#${i}`,
      url: meta.url,
      title: meta.title,
      description: meta.description,
      section: meta.section,
      chunkIndex: i,
      chunkCount: pieces.length,
      text,
    };
    if (meta.repo !== undefined) chunk.repo = meta.repo;
    if (meta.path !== undefined) chunk.path = meta.path;
    if (meta.language !== undefined) chunk.language = meta.language;
    return chunk;
  });
}

/**
 * Turn a source id + long text into a list of chunks with stable keys and
 * consistent metadata. `keyPrefix` namespaces the id (e.g. "github:aws-nuke").
 */
export function toChunks(params: ChunkMeta & { text: string; opts?: ChunkOptions }): Chunk[] {
  return fromPieces(params, chunkWords(params.text, params.opts));
}
