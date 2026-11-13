/**
 * Code-aware helpers for ingesting real source files (not just READMEs).
 *
 * Three jobs:
 *  1. Decide which files in a repo are worth embedding (`classifyPath`).
 *  2. Split source files into line-aligned chunks that keep code readable
 *     (`chunkCode`) — word-window chunking mangles indentation and syntax.
 *  3. Build a per-repo "architecture map" (`buildRepoOverview`) so the model can
 *     answer structural questions ("how is this laid out?") and not only
 *     questions that happen to match one file.
 */

/** Extension -> human language label, used as embedding signal + result badge. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript (React)",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript (React)",
  mjs: "JavaScript",
  cjs: "JavaScript",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  swift: "Swift",
  c: "C",
  h: "C/C++ header",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++ header",
  hh: "C++ header",
  cs: "C#",
  php: "PHP",
  pl: "Perl",
  pm: "Perl",
  lua: "Lua",
  r: "R",
  jl: "Julia",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hrl: "Erlang",
  hs: "Haskell",
  elm: "Elm",
  clj: "Clojure",
  cljs: "ClojureScript",
  cljc: "Clojure",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  ps1: "PowerShell",
  psm1: "PowerShell",
  bat: "Batch",
  cmd: "Batch",
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protocol Buffers",
  thrift: "Thrift",
  tf: "Terraform",
  tfvars: "Terraform",
  hcl: "HCL",
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  jsonc: "JSON",
  toml: "TOML",
  ini: "INI",
  cfg: "Config",
  conf: "Config",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  styl: "Stylus",
  md: "Markdown",
  mdx: "MDX",
  rst: "reStructuredText",
  adoc: "AsciiDoc",
  txt: "Text",
};

/** Extensionless files that are still meaningful source/infra. */
const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: "Dockerfile",
  containerfile: "Dockerfile",
  makefile: "Makefile",
  gnumakefile: "Makefile",
  jenkinsfile: "Jenkinsfile",
  procfile: "Procfile",
  gemfile: "Ruby",
  rakefile: "Ruby",
  vagrantfile: "Ruby",
  brewfile: "Homebrew",
  justfile: "Just",
  "cmakelists.txt": "CMake",
};

/** Directory names whose contents are dependencies or build output, never authored logic. */
const SKIP_DIRS = new Set([
  ".git",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".terraform",
  ".venv",
  ".gradle",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "thirdparty",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "htmlcov",
  "site-packages",
  "venv",
  "obj",
  "generated",
  "__snapshots__",
  "fixtures",
  "testdata",
]);

/** Lockfiles and generated manifests: huge, zero architectural signal. */
const SKIP_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "podfile.lock",
  "go.sum",
  "mix.lock",
  "packages.lock.json",
  "pubspec.lock",
  "flake.lock",
  "tsconfig.tsbuildinfo",
  ".ds_store",
  "license",
  "license.md",
  "license.txt",
  "copying",
  "notice",
  "codeowners",
]);

/**
 * Anything that could carry a credential. These repos are public so secrets
 * shouldn't be there at all, but never ship them into an index that a public
 * chatbot reads from.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)credentials?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i,
  /(^|\/)secrets?\./i,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk)$/i,
  /\.tfstate(\.backup)?$/i,
];

/** Binary / asset / data extensions that must never be embedded. */
const BINARY_EXTS = new Set([
  "png","jpg","jpeg","gif","bmp","ico","webp","avif","tif","tiff","svg","psd","ai","eps",
  "mp3","mp4","m4a","mov","avi","mkv","webm","wav","flac","ogg",
  "pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods",
  "zip","tar","gz","tgz","bz2","xz","7z","rar","jar","war","ear",
  "woff","woff2","ttf","eot","otf",
  "exe","dll","so","dylib","a","lib","o","obj","bin","dat","img","iso",
  "db","sqlite","sqlite3","mdb","parquet","avro","pyc","pyo","pyd","class","wasm","node",
  "lock","log","csv","tsv","xlsb","ipynb","min",
]);

export interface PathClassification {
  include: boolean;
  language: string;
  /** Why it was skipped — surfaced in the ingest log so the filter is auditable. */
  reason?: string;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

/** Decide whether a repo-relative path is authored source worth embedding. */
export function classifyPath(path: string): PathClassification {
  const lower = path.toLowerCase();
  const base = basenameOf(path);
  const ext = extensionOf(path);

  for (const re of SECRET_PATTERNS) {
    if (re.test(lower)) return { include: false, language: "", reason: "possible secret" };
  }

  for (const segment of lower.split("/").slice(0, -1)) {
    if (SKIP_DIRS.has(segment)) {
      return { include: false, language: "", reason: `in ${segment}/` };
    }
  }

  if (SKIP_BASENAMES.has(base)) return { include: false, language: "", reason: "lockfile/boilerplate" };
  if (/\.min\.(js|css|mjs)$/i.test(base)) return { include: false, language: "", reason: "minified" };
  if (/\.(map|snap)$/i.test(base)) return { include: false, language: "", reason: "generated" };
  if (/\.d\.ts$/i.test(base)) return { include: false, language: "", reason: "type declarations" };
  if (BINARY_EXTS.has(ext)) return { include: false, language: "", reason: "binary/data" };

  const byBase = LANGUAGE_BY_BASENAME[base];
  if (byBase) return { include: true, language: byBase };

  // Dockerfile.prod, Dockerfile-dev, etc.
  if (base.startsWith("dockerfile")) return { include: true, language: "Dockerfile" };

  const byExt = ext ? LANGUAGE_BY_EXT[ext] : undefined;
  if (byExt) return { include: true, language: byExt };

  return { include: false, language: "", reason: ext ? `unknown .${ext}` : "no extension" };
}

export interface CodeChunkOptions {
  /** Max source lines per chunk. */
  lines?: number;
  /** Lines repeated between consecutive chunks so definitions aren't cut in half. */
  overlap?: number;
  /** Hard character ceiling per chunk (keeps us inside the embedding input limit). */
  maxChars?: number;
}

/** A code chunk plus the structural signal that makes it findable. */
export interface CodeChunk {
  /** The source text of the chunk (indentation and newlines preserved). */
  text: string;
  /** 1-based inclusive line range in the file, for citation and neighbour ordering. */
  startLine: number;
  endLine: number;
  /** Definition names found in the chunk (functions, classes, resources, …). */
  symbols: string[];
}

const DEFAULT_CODE_LINES = 80;
const DEFAULT_CODE_OVERLAP = 12;
const DEFAULT_CODE_MAX_CHARS = 3200;
/**
 * Don't cut a chunk shorter than this fraction of the max just to land on a nice
 * boundary — otherwise a file full of one-line definitions produces a chunk per
 * line, and each embedding loses its surrounding context.
 */
const MIN_FILL_FRACTION = 0.5;

/**
 * Lines that begin a definition, at TOP LEVEL or one level of nesting only
 * (≤2 leading spaces / one tab). Restricting the indentation is deliberate:
 * breaking before a top-level `function`/`class` keeps whole units together,
 * whereas breaking before a deeply-nested definition would split its parent.
 *
 * Covers the languages actually in these repos — TS/JS, Python, Go, Rust, shell,
 * Terraform/HCL — plus common C-family/Java keywords. It only has to be good
 * enough to *prefer* a boundary, never exhaustive.
 */
const DEFINITION_START =
  /^(?:[ ]{0,2}|\t)(?:export\s+|default\s+|public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+|pub\s+)*(?:function\b|class\b|interface\b|type\s|enum\b|namespace\b|module\b|def\s|func\b|fn\s|impl\b|struct\b|trait\b|const\s|let\s|var\s|resource\s|data\s|variable\s|output\s|provider\s|@|#\[)/;

/**
 * Regexes that capture a definition NAME. Applied per chunk; group 1 is the name
 * unless `join` is set (HCL block type + labels). Every match is collected.
 */
const SYMBOL_PATTERNS: { re: RegExp; join?: boolean }[] = [
  // JS/TS — anchored to the line start (allowing modifiers) so it captures
  // top-level DECLARATIONS, not locals inside a function body or names in an
  // `import { ... }` line. This is what keeps "Defines:" meaningful.
  {
    re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
  },
  { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm },
  // Python — methods are indented, so `^\s*` intentionally captures them too.
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm },
  { re: /^\s*class\s+([A-Za-z_]\w*)/gm },
  // Go / Rust
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm },
  { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm },
  { re: /^\s*(?:pub\s+)?(?:struct|trait|impl|enum)\s+([A-Za-z_]\w*)/gm },
  // Shell:  name() {   or   function name {
  { re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm },
  // Terraform/HCL:  resource "aws_s3_bucket" "frontend" -> resource.aws_s3_bucket.frontend
  {
    re: /^\s*(resource|data|module|variable|output|provider)\s+"([^"]+)"(?:\s+"([^"]+)")?/gm,
    join: true,
  },
];

const MAX_SYMBOLS_PER_CHUNK = 24;
const MAX_SYMBOL_LEN = 48;
/** Single-character names are almost always throwaway locals, not useful signal. */
const MIN_SYMBOL_LEN = 2;

/** Pull likely definition names out of a chunk, in first-seen order, deduped. */
function extractSymbols(code: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const { re, join } of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const name = join ? m.slice(1).filter(Boolean).join(".") : m[1];
      if (!name || name.length < MIN_SYMBOL_LEN || name.length > MAX_SYMBOL_LEN) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= MAX_SYMBOLS_PER_CHUNK) return out;
    }
  }
  return out;
}

/**
 * Split source into line-aligned, overlapping windows that try to end on a
 * natural boundary (a blank line or the start of the next definition) rather than
 * an arbitrary line count — so a function is far less likely to be cut in half.
 *
 * Unlike the prose chunker this preserves newlines and indentation. Windows are
 * bounded by BOTH a line count and a character ceiling, so a file with a few very
 * long lines can't blow past the embedding input limit. Each chunk also carries
 * its line range and the definition names it contains, which is what lets the
 * retrieval side match a plain-English question to the right code.
 */
export function chunkCode(text: string, opts: CodeChunkOptions = {}): CodeChunk[] {
  const maxLines = Math.max(1, opts.lines ?? DEFAULT_CODE_LINES);
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_CODE_MAX_CHARS);
  const overlap = Math.min(Math.max(0, opts.overlap ?? DEFAULT_CODE_OVERLAP), maxLines - 1);
  const minFill = Math.max(1, Math.floor(maxLines * MIN_FILL_FRACTION));

  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // Defensive: a single pathological line (leftover minified blob) must not
    // become a chunk that exceeds the embedding limit on its own.
    .map((line) => (line.length > maxChars ? `${line.slice(0, maxChars)} /* …truncated */` : line));

  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  if (lines.length === 0) return [];

  const chunks: CodeChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    // 1. Grow greedily until the line or char ceiling.
    let end = start;
    let chars = 0;
    while (end < lines.length) {
      const cost = (lines[end] ?? "").length + 1;
      if (end > start && (end - start >= maxLines || chars + cost > maxChars)) break;
      chars += cost;
      end += 1;
    }

    // 2. If more file remains, pull `end` back to a nicer boundary when one sits
    //    past the minimum fill: prefer the start of the next definition, else a
    //    blank line. This keeps whole functions/blocks inside one chunk.
    if (end < lines.length) {
      const floor = start + minFill;
      let cut = -1;
      for (let j = end; j > floor; j -= 1) {
        if (DEFINITION_START.test(lines[j] ?? "")) {
          cut = j;
          break;
        }
      }
      if (cut === -1) {
        for (let j = end; j > floor; j -= 1) {
          if ((lines[j - 1] ?? "").trim() === "") {
            cut = j;
            break;
          }
        }
      }
      if (cut > start) end = cut;
    }

    const piece = lines.slice(start, end).join("\n").trim();
    if (piece !== "") {
      chunks.push({
        text: piece,
        startLine: start + 1,
        endLine: end,
        symbols: extractSymbols(piece),
      });
    }

    if (end >= lines.length) break;
    start += Math.max(1, end - start - overlap);
  }
  return chunks;
}

export interface RepoFile {
  path: string;
  size: number;
  language: string;
}

export interface RepoFacts {
  name: string;
  owner: string;
  description: string | null;
  language: string | null;
  topics: string[];
  homepage: string | null;
  stars: number;
  license: string | null;
  archived: boolean;
  pushedAt: string;
  defaultBranch: string;
}

/** Group file paths by their top-level directory for a compact layout summary. */
function layoutSummary(files: RepoFile[]): string[] {
  const byTop = new Map<string, number>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    const top = slash === -1 ? "(root)" : `${f.path.slice(0, slash)}/`;
    byTop.set(top, (byTop.get(top) ?? 0) + 1);
  }
  return [...byTop.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir, n]) => `${dir} (${n} file${n === 1 ? "" : "s"})`);
}

/** Count files per language so the model can describe the stack accurately. */
function stackSummary(files: RepoFile[]): string[] {
  const byLang = new Map<string, number>();
  for (const f of files) byLang.set(f.language, (byLang.get(f.language) ?? 0) + 1);
  return [...byLang.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang, n]) => `${lang} (${n})`);
}

const MAX_LISTED_PATHS = 400;

/**
 * A single "architecture map" passage per repo: metadata, tech stack, directory
 * layout and the full file list. This is what lets the chatbot answer
 * "how is project X structured?" rather than only quoting one matching file.
 */
export function buildRepoOverview(repo: RepoFacts, files: RepoFile[]): string {
  const listed = files.slice(0, MAX_LISTED_PATHS).map((f) => f.path);
  const omitted = files.length - listed.length;

  const parts: string[] = [
    `Architecture and file layout of my open-source project "${repo.name}" (github.com/${repo.owner}/${repo.name}).`,
  ];

  if (repo.description) parts.push(`Description: ${repo.description}.`);
  if (repo.language) parts.push(`Primary language: ${repo.language}.`);
  if (repo.license) parts.push(`License: ${repo.license}.`);
  if (repo.topics.length) parts.push(`Topics: ${repo.topics.join(", ")}.`);
  if (repo.homepage) parts.push(`Homepage: ${repo.homepage}.`);
  if (repo.stars) parts.push(`Stars: ${repo.stars}.`);
  if (repo.archived) parts.push("This repository is archived (no longer actively developed).");
  parts.push(`Last pushed: ${repo.pushedAt.slice(0, 10)}. Default branch: ${repo.defaultBranch}.`);

  parts.push("", `Indexed source files: ${files.length}.`);
  parts.push(`Tech stack by file count: ${stackSummary(files).join(", ")}.`);
  parts.push("", "Top-level layout:", ...layoutSummary(files).map((l) => `- ${l}`));
  parts.push("", "Source files:", ...listed.map((p) => `- ${p}`));
  if (omitted > 0) parts.push(`- …and ${omitted} more file(s).`);

  return parts.join("\n");
}
