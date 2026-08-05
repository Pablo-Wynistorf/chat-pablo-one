export interface PageMetadata {
  /** Full URL of the page this chunk came from. */
  url: string;
  title: string;
  description: string;
  /** Top-level section, e.g. "projects", "certifications". */
  section: string;
  /** Which chunk of the page this vector represents. */
  chunkIndex: number;
  /** Short preview of the matching passage. */
  text: string;
  /** Repo name, present on source-code chunks (section "code"). */
  repo?: string;
  /** Repo-relative file path, e.g. "indexer/lib/chunk.ts". */
  path?: string;
  /** Language label, e.g. "TypeScript". */
  language?: string;
}

/** A single matched page-chunk straight from the vector index (full passage). */
export interface ChunkMatch {
  url: string;
  title: string;
  description: string;
  section: string;
  chunkIndex: number;
  /** Full stored passage for this chunk — the raw material for RAG grounding. */
  text: string;
  /** Similarity in [0, 1], derived from the cosine distance. */
  score: number;
  /** Repo name, present on source-code chunks. */
  repo?: string;
  /** Repo-relative file path, present on source-code chunks. */
  path?: string;
  /** Language label, present on source-code chunks. */
  language?: string;
}

/** One matched page (best chunk kept after de-duplicating by URL). */
export interface PageResult {
  url: string;
  title: string;
  description: string;
  section: string;
  /** Similarity in [0, 1], derived from the cosine distance. */
  score: number;
  /** The best-matching passage snippet on that page. */
  snippet: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /**
   * Set when a guardrail blocked this turn. Blocked turns are stripped from the
   * history before it reaches Bedrock — guardrails re-evaluate the entire
   * `messages` array on every call, so leaving a blocked question in history
   * makes every later message trip the guardrail too.
   */
  blocked?: boolean;
}

/**
 * Appended to the response body when a guardrail intervened. The answer streams
 * as plain text and headers are already committed by the time we know, so the
 * signal has to ride along in the body. The client strips it before display.
 */
export const BLOCKED_SENTINEL = "\u0000guardrail-blocked\u0000";

/** A page cited by the chatbot as the source of its answer. */
export interface ChatSource {
  url: string;
  title: string;
  section: string;
  score: number;
}
