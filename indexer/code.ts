/**
 * Ingests the ACTUAL SOURCE CODE of every public repo, so the chatbot can answer
 * detailed design/architecture questions instead of only paraphrasing READMEs.
 *
 *   GITHUB_TOKEN=ghp_... npm run ingest:code
 *
 * For each non-fork repo:
 *   1. List every file on the default branch (git trees API, recursive).
 *   2. Keep authored source/config/infra files (see lib/code.ts for the filter —
 *      dependencies, build output, lockfiles, binaries and anything that smells
 *      like a credential are excluded).
 *   3. Emit one "architecture map" chunk per repo (stack, layout, full file list).
 *   4. Fetch each file from raw.githubusercontent.com and split it into
 *      line-aligned, overlapping chunks that keep the code readable.
 *
 * Output: data/code.json. This complements data/github.json (repo prose/READMEs).
 *
 * A GITHUB_TOKEN is effectively required: listing trees for many repos will blow
 * through the 60 req/hr unauthenticated limit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Chunk, fromPieces } from "./lib/chunk.js";
import {
  buildRepoOverview,
  chunkCode,
  classifyPath,
  type CodeChunk,
  type RepoFacts,
  type RepoFile,
} from "./lib/code.js";
import {
  blobUrl,
  fetchAllRepos,
  fetchRepoTree,
  fetchRawFile,
  GH_TOKEN,
  GH_USER,
  type Repo,
} from "./lib/github.js";
import { mapPool } from "./lib/pool.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");

/** Parallel raw-file downloads. raw.githubusercontent.com is not rate limited. */
const FETCH_CONCURRENCY = 12;
/** Skip files above this size — usually generated data, not authored logic. */
const MAX_FILE_BYTES = Number(process.env.CODE_MAX_FILE_BYTES ?? 160_000);
/** Safety valve per repo so one monorepo can't dominate the whole index. */
const MAX_FILES_PER_REPO = Number(process.env.CODE_MAX_FILES_PER_REPO ?? 300);
/** Archived repos are still the author's own work and valid architecture material. */
const INCLUDE_ARCHIVED = (process.env.CODE_INCLUDE_ARCHIVED ?? "true") !== "false";
/** Optional comma-separated allow-list, e.g. CODE_REPOS=aws-nuke,pablo-one */
const ONLY_REPOS = (process.env.CODE_REPOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function facts(repo: Repo): RepoFacts {
  return {
    name: repo.name,
    owner: GH_USER,
    description: repo.description,
    language: repo.language,
    topics: repo.topics ?? [],
    homepage: repo.homepage && repo.homepage.trim() !== "" ? repo.homepage : null,
    stars: repo.stargazers_count,
    license: repo.license?.spdx_id && repo.license.spdx_id !== "NOASSERTION"
      ? repo.license.spdx_id
      : (repo.license?.name ?? null),
    archived: repo.archived,
    pushedAt: repo.pushed_at,
    defaultBranch: repo.default_branch,
  };
}

/**
 * Prefix each code chunk with a header carrying its location and structure.
 *
 * This is the single biggest lever on code-answer accuracy. The header is part of
 * the embedded text, so it does three things at once:
 *  - locational signal: "how does the indexer chunk text?" matches `indexer/lib/chunk.ts`;
 *  - semantic signal: the `Defines:` line puts real identifier names (a natural-language-ish
 *    signal) next to the raw code, so a plain-English question matches the chunk that
 *    actually declares that function/resource, not just one that mentions it;
 *  - citation signal: the model sees the exact file and line range it is quoting.
 */
function codeHeader(
  repo: string,
  path: string,
  language: string,
  chunk: CodeChunk,
  totalLines: number,
): string {
  const range = `lines ${chunk.startLine}\u2013${chunk.endLine} of ${totalLines}`;
  const defines =
    chunk.symbols.length > 0 ? `\nDefines: ${chunk.symbols.join(", ")}` : "";
  return `File: ${repo}/${path} — ${language} · ${range}${defines}`;
}

/** Count of newline-delimited lines, matching how chunkCode measures the file. */
function countLines(text: string): number {
  return text.replace(/\r\n?/g, "\n").split("\n").length;
}

async function ingestRepo(repo: Repo): Promise<Chunk[]> {
  const { entries, truncated } = await fetchRepoTree(repo);
  if (truncated) {
    console.warn(`  ! ${repo.name}: GitHub truncated the file tree; indexing what we got.`);
  }

  const candidates: RepoFile[] = [];
  let skippedTooBig = 0;
  for (const entry of entries) {
    const verdict = classifyPath(entry.path);
    if (!verdict.include) continue;
    const size = entry.size ?? 0;
    if (size > MAX_FILE_BYTES) {
      skippedTooBig += 1;
      continue;
    }
    candidates.push({ path: entry.path, size, language: verdict.language });
  }

  // Prefer smaller, more numerous files when a repo exceeds the cap: they are
  // usually the real modules, while the biggest files tend to be generated.
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const overflow = Math.max(0, candidates.length - MAX_FILES_PER_REPO);
  const files = overflow > 0
    ? [...candidates].sort((a, b) => a.size - b.size).slice(0, MAX_FILES_PER_REPO)
        .sort((a, b) => a.path.localeCompare(b.path))
    : candidates;

  if (files.length === 0) {
    console.log(`  — ${repo.name}: no indexable source files`);
    return [];
  }

  const chunks: Chunk[] = [];

  // 1. The architecture map for the whole repo.
  chunks.push(
    ...fromPieces(
      {
        keyPrefix: `code:${repo.name}:__overview__`,
        url: repo.html_url,
        title: `${repo.name} — architecture & file layout`,
        description: repo.description ?? "",
        section: "code",
        repo: repo.name,
        language: repo.language ?? "",
      },
      [buildRepoOverview(facts(repo), files)],
    ),
  );

  // 2. Every source file, line-chunked.
  let fileCount = 0;
  const perFile = await mapPool(files, FETCH_CONCURRENCY, async (file) => {
    const text = await fetchRawFile(repo, file.path);
    if (text === null || text.trim() === "") return [];

    const pieces = chunkCode(text);
    if (pieces.length === 0) return [];
    fileCount += 1;

    const totalLines = countLines(text);
    return fromPieces(
      {
        keyPrefix: `code:${repo.name}:${file.path}`,
        url: blobUrl(repo, file.path),
        title: `${repo.name}/${file.path}`,
        description: repo.description ?? "",
        section: "code",
        repo: repo.name,
        path: file.path,
        language: file.language,
      },
      pieces.map(
        (chunk) =>
          `${codeHeader(repo.name, file.path, file.language, chunk, totalLines)}\n\n${chunk.text}`,
      ),
    );
  });

  for (const list of perFile) chunks.push(...list);

  const notes = [
    `${fileCount} file(s)`,
    `${chunks.length} chunk(s)`,
    skippedTooBig > 0 ? `${skippedTooBig} too large` : "",
    overflow > 0 ? `${overflow} over cap` : "",
  ].filter(Boolean);
  console.log(`  ✓ ${repo.name} → ${notes.join(", ")}`);

  return chunks;
}

async function main(): Promise<void> {
  if (!GH_TOKEN) {
    console.warn(
      "⚠ No GITHUB_TOKEN set. The GitHub API allows only 60 requests/hour\n" +
        "  unauthenticated, which is not enough to list trees for every repo.\n" +
        "  Create a read-only token and re-run:  GITHUB_TOKEN=... npm run ingest:code\n",
    );
  }

  console.log(`Fetching public repos for github.com/${GH_USER}\n`);
  const repos = await fetchAllRepos();

  let own = repos.filter((r) => !r.fork);
  if (!INCLUDE_ARCHIVED) own = own.filter((r) => !r.archived);
  if (ONLY_REPOS.length > 0) {
    const wanted = new Set(ONLY_REPOS.map((s) => s.toLowerCase()));
    own = own.filter((r) => wanted.has(r.name.toLowerCase()));
  }
  own.sort((a, b) => a.name.localeCompare(b.name));

  console.log(
    `${repos.length} repos total, ingesting source for ${own.length} ` +
      `(non-fork${INCLUDE_ARCHIVED ? ", archived included" : ", archived excluded"}).\n`,
  );

  const allChunks: Chunk[] = [];
  for (const repo of own) {
    try {
      allChunks.push(...(await ingestRepo(repo)));
    } catch (err) {
      // One unreachable repo shouldn't throw away every other repo's work.
      console.error(`  ✖ ${repo.name}: ${(err as Error).message}`);
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, "code.json");
  writeFileSync(outPath, `${JSON.stringify(allChunks, null, 2)}\n`, "utf8");

  const chars = allChunks.reduce((sum, c) => sum + c.text.length, 0);
  console.log("\n──────────────────────────────────────────────");
  console.log(`Repos with source : ${own.length}`);
  console.log(`Total chunks      : ${allChunks.length}`);
  console.log(`Total characters  : ${chars.toLocaleString()}`);
  console.log(`Written to        : ${outPath}`);
  console.log("──────────────────────────────────────────────");
  console.log("Next:  npm run index");
}

main().catch((err) => {
  console.error("Code ingest failed:", err);
  process.exit(1);
});
