/**
 * Crawls the target website and writes one JSON file of text chunks ready to be
 * embedded and inserted into S3 Vectors.
 *
 *   npm run crawl
 *
 * Strategy: read the site's sitemap.xml to discover every page (a Hugo site
 * publishes one automatically), fetch each URL, strip chrome (nav / header /
 * footer / scripts), extract the readable text, and split it into overlapping
 * word-windows. Each window becomes one vector so a query can land on the exact
 * passage — and we return the page URL where that passage lives.
 *
 * Output: indexer/pages.json  -> Chunk[]
 */
import * as cheerio from "cheerio";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Chunk, chunkWords } from "./lib/chunk.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "data");

const SITE_URL = (process.env.SITE_URL ?? "https://www.pablo.one").replace(/\/$/, "");
const USER_AGENT = "pablo-one-poc-indexer/0.1 (+https://www.pablo.one)";

// Skip pages whose extracted body is shorter than this (empty taxonomy stubs).
const MIN_CHUNK_WORDS = 25;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) {
      console.warn(`  skip ${url} (HTTP ${res.status})`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`  skip ${url} (${(err as Error).message})`);
    return null;
  }
}

/** Pull every same-host <loc> URL out of a sitemap.xml. */
function parseSitemap(xml: string, host: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = new Set<string>();
  $("loc").each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    // Normalise scheme + host so http/https and www variants collapse together.
    try {
      const u = new URL(raw);
      if (u.host !== host) return;
      urls.add(`https://${host}${u.pathname}`);
    } catch {
      /* ignore malformed */
    }
  });
  return [...urls].sort();
}

const slugOf = (url: string): string => {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  return path === "" ? "home" : path.replace(/\//g, "-");
};

const sectionOf = (url: string): string => {
  const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
  if (path === "") return "home";
  return path.split("/")[0] ?? "home";
};

/** Strip chrome and return { title, description, text } for a page. */
function extract(html: string): { title: string; description: string; text: string } {
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "(untitled)";

  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";

  // Drop everything that is chrome, not content.
  $(
    "script, style, noscript, svg, nav, header, footer, aside, form, .menu, .sidebar, .hamburger",
  ).remove();

  // Prefer the article body; fall back progressively.
  const scope =
    ($(".article-content").length && $(".article-content")) ||
    ($("article").length && $("article")) ||
    ($("main").length && $("main")) ||
    $("body");

  const text = scope.text().replace(/\s+/g, " ").trim();
  return { title, description, text };
}

async function main(): Promise<void> {
  const host = new URL(SITE_URL).host;
  console.log(`Crawling ${SITE_URL} (host: ${host})\n`);

  const sitemapXml = await fetchText(`${SITE_URL}/sitemap.xml`);
  if (!sitemapXml) {
    console.error(`Could not read ${SITE_URL}/sitemap.xml — is the site reachable?`);
    process.exit(1);
  }

  const urls = parseSitemap(sitemapXml, host);
  console.log(`Found ${urls.length} URLs in sitemap.\n`);

  const allChunks: Chunk[] = [];
  let pagesKept = 0;
  let pagesSkipped = 0;

  for (const url of urls) {
    const html = await fetchText(url);
    if (!html) {
      pagesSkipped += 1;
      continue;
    }

    const { title, description, text } = extract(html);
    const pieces = chunkWords(text);

    // Drop empty / near-empty pages (e.g. bare taxonomy listing stubs).
    if (pieces.length === 0 || text.split(/\s+/).length < MIN_CHUNK_WORDS) {
      console.log(`  — skip ${url} (only ${text.split(/\s+/).filter(Boolean).length} words)`);
      pagesSkipped += 1;
      continue;
    }

    const slug = slugOf(url);
    const section = sectionOf(url);
    pieces.forEach((chunkText, i) => {
      allChunks.push({
        id: `website:${slug}#${i}`,
        url,
        title,
        description,
        section: section === "home" ? "website" : section,
        chunkIndex: i,
        chunkCount: pieces.length,
        text: chunkText,
      });
    });
    pagesKept += 1;
    console.log(`  ✓ ${url} → ${pieces.length} chunk(s) [${title}]`);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outPath = join(DATA_DIR, "pages.json");
  writeFileSync(outPath, `${JSON.stringify(allChunks, null, 2)}\n`, "utf8");

  console.log("\n──────────────────────────────────────────────");
  console.log(`Pages kept    : ${pagesKept}`);
  console.log(`Pages skipped : ${pagesSkipped}`);
  console.log(`Total chunks  : ${allChunks.length}`);
  console.log(`Written to    : ${outPath}`);
  console.log("──────────────────────────────────────────────");
  console.log("Next: `npm run ingest:github`, `npm run ingest:docs`, then `npm run index`.");
}

main().catch((err) => {
  console.error("Crawl failed:", err);
  process.exit(1);
});
