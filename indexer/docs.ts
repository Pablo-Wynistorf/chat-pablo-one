/**
 * Ingests hand-curated markdown documents from `indexer/sources/*.md`.
 *
 *   npm run ingest:docs
 *
 * This is the "train it on more data" hook: drop a markdown file in sources/,
 * give it a small front-matter header, and its content becomes searchable.
 * Used here for the LinkedIn profile (LinkedIn blocks automated scraping, so the
 * content is curated) and extra researched background facts. Output: data/docs.json.
 *
 * Front-matter format (first lines of the file):
 *
 *   ---
 *   title: LinkedIn — Pablo Wynistorf
 *   url: https://www.linkedin.com/in/pablo-wynistorf/
 *   section: linkedin
 *   ---
 *   <markdown body>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Chunk, toChunks } from "./lib/chunk.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");
const SOURCES_DIR = join(HERE, "sources");

interface FrontMatter {
  title: string;
  url: string;
  section: string;
  description: string;
  body: string;
}

function parse(raw: string, fallbackTitle: string): FrontMatter {
  const meta: Record<string, string> = {};
  let body = raw;

  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fm) {
    for (const line of fm[1]!.split("\n")) {
      const m = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.trim();
    }
    body = fm[2] ?? "";
  }

  return {
    title: meta.title ?? fallbackTitle,
    url: meta.url ?? "",
    section: meta.section ?? "about",
    description: meta.description ?? "",
    body,
  };
}

function cleanMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    // Unwrap inline code, don't delete it. Deleting it silently dropped every
    // backticked term from the index: about.md's "AWS automation & tooling:
    // `aws-nuke`, `aws-regionator`, `lambda-layergen`" was stored as
    // "AWS automation & tooling: , , " — the repo names, service names and file
    // paths are exactly the words people search for.
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*\-|]+/gm, " ")
    .replace(/[*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function main(): void {
  if (!existsSync(SOURCES_DIR)) {
    console.error(`No sources/ directory at ${SOURCES_DIR}. Nothing to ingest.`);
    process.exit(1);
  }

  const files = readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.error("No .md files in sources/. Nothing to ingest.");
    process.exit(1);
  }

  const allChunks: Chunk[] = [];
  for (const file of files) {
    const raw = readFileSync(join(SOURCES_DIR, file), "utf8");
    const fm = parse(raw, file.replace(/\.md$/, ""));
    const text = cleanMarkdown(fm.body);
    if (!text) {
      console.log(`  — skip ${file} (empty body)`);
      continue;
    }
    const chunks = toChunks({
      keyPrefix: `doc:${file.replace(/\.md$/, "")}`,
      url: fm.url,
      title: fm.title,
      description: fm.description,
      section: fm.section,
      text,
    });
    allChunks.push(...chunks);
    console.log(`  ✓ ${file} → ${chunks.length} chunk(s) [${fm.section}]`);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, "docs.json");
  writeFileSync(outPath, `${JSON.stringify(allChunks, null, 2)}\n`, "utf8");

  console.log("\n──────────────────────────────────────────────");
  console.log(`Docs ingested : ${files.length}`);
  console.log(`Total chunks  : ${allChunks.length}`);
  console.log(`Written to    : ${outPath}`);
  console.log("──────────────────────────────────────────────");
}

main();
