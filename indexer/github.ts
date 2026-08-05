/**
 * Ingests a GitHub user's public repositories so the chatbot can answer
 * questions about their projects.
 *
 *   npm run ingest:github
 *
 * For each non-fork repo we combine its metadata (name, description, language,
 * topics, homepage) with the README and chunk it. Output: data/github.json.
 *
 * This covers the *prose* about each project. The actual source code is ingested
 * separately by `npm run ingest:code` (see code.ts) — run both if you want the
 * chatbot to discuss implementation details and architecture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Chunk, toChunks } from "./lib/chunk.js";
import { fetchAllRepos, fetchReadme, GH_USER } from "./lib/github.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");

/**
 * Strip markdown *formatting* noise while KEEPING fenced code blocks.
 *
 * READMEs are where projects explain their architecture, and those explanations
 * are usually half prose and half code (config snippets, CLI usage, example
 * requests). Dropping the code blocks — as an earlier version did — threw away
 * exactly the detail needed to answer implementation questions.
 */
function cleanMarkdown(md: string): string {
  const blocks: string[] = [];
  // Park fenced blocks, clean the prose around them, then restore verbatim.
  const parked = md.replace(/```[\s\S]*?```/g, (block) => {
    const body = block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "").trimEnd();
    blocks.push(body);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  const prose = parked
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/<[^>]+>/g, " ") // stray HTML
    .replace(/^[#>*\-|]+/gm, " ") // markdown markers at line start
    .replace(/[*_~]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return prose.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => `\n${blocks[Number(i)] ?? ""}\n`);
}

async function main(): Promise<void> {
  console.log(`Fetching public repos for github.com/${GH_USER}\n`);
  const repos = await fetchAllRepos();

  // Only the user's own, non-archived projects — forks aren't really "his".
  const own = repos.filter((r) => !r.fork && !r.archived);
  console.log(`${repos.length} repos total, ${own.length} own (non-fork, non-archived).\n`);

  const allChunks: Chunk[] = [];
  for (const repo of own) {
    const readme = cleanMarkdown(await fetchReadme(repo));
    const topics = repo.topics && repo.topics.length ? `Topics: ${repo.topics.join(", ")}.` : "";
    const facts = [
      `GitHub project "${repo.name}" by ${GH_USER}.`,
      repo.description ? `Description: ${repo.description}.` : "",
      repo.language ? `Primary language: ${repo.language}.` : "",
      topics,
      repo.homepage ? `Live/homepage: ${repo.homepage}.` : "",
      repo.stargazers_count ? `Stars: ${repo.stargazers_count}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const text = readme ? `${facts}\n\n${readme}` : facts;

    const chunks = toChunks({
      keyPrefix: `github:${repo.name}`,
      url: repo.html_url,
      title: `${repo.name} (GitHub)`,
      description: repo.description ?? "",
      section: "github",
      repo: repo.name,
      text,
    });
    allChunks.push(...chunks);
    console.log(`  ✓ ${repo.name} → ${chunks.length} chunk(s)${readme ? "" : " (no README)"}`);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, "github.json");
  writeFileSync(outPath, `${JSON.stringify(allChunks, null, 2)}\n`, "utf8");

  console.log("\n──────────────────────────────────────────────");
  console.log(`Repos indexed : ${own.length}`);
  console.log(`Total chunks  : ${allChunks.length}`);
  console.log(`Written to    : ${outPath}`);
  console.log("──────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("GitHub ingest failed:", err);
  process.exit(1);
});
