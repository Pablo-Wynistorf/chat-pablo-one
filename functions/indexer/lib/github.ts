/**
 * Shared GitHub access for the ingest scripts.
 *
 * READMEs and file contents come from raw.githubusercontent.com (no API rate
 * limit). Repo listings and file trees need the REST API:
 *
 *   - unauthenticated: 60 requests/hour — enough for a handful of repos
 *   - with GITHUB_TOKEN: 5,000 requests/hour — required for full source ingest
 *
 * Set GITHUB_TOKEN (a classic token with `public_repo`, or a fine-grained token
 * with read-only "Contents" access) before running `npm run ingest:code`.
 */
import { withRetry } from "./retry.js";

export const GH_USER = process.env.GITHUB_USER ?? "Pablo-Wynistorf";
export const GH_TOKEN = process.env.GITHUB_TOKEN;

const USER_AGENT = "pablo-one-poc-indexer/0.2";
const API = "https://api.github.com";

export interface Repo {
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  homepage: string | null;
  default_branch: string;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  pushed_at: string;
  size: number;
  license?: { spdx_id?: string | null; name?: string | null } | null;
}

export interface TreeEntry {
  path: string;
  /** "blob" = file, "tree" = directory. */
  type: string;
  size?: number;
}

export function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (GH_TOKEN) h.authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

function rateLimitHint(res: Response): string {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining === "0") {
    const reset = res.headers.get("x-ratelimit-reset");
    const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
    return GH_TOKEN
      ? ` Rate limit exhausted, resets around ${when}.`
      : ` Rate limit exhausted (60/hr unauthenticated), resets around ${when}. Set GITHUB_TOKEN to raise it to 5,000/hr.`;
  }
  return "";
}

async function ghJson<T>(url: string): Promise<T> {
  const res = await withRetry(async () => {
    const r = await fetch(url, { headers: ghHeaders() });
    if (!r.ok && (r.status === 429 || r.status >= 500)) {
      // Shape the error so withRetry treats it as transient.
      throw Object.assign(new Error(`GitHub ${r.status} for ${url}`), {
        $metadata: { httpStatusCode: r.status },
      });
    }
    return r;
  });

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}.${rateLimitHint(res)}`);
  }
  return (await res.json()) as T;
}

/** Every public repo for the user, following pagination (not just the first 100). */
export async function fetchAllRepos(): Promise<Repo[]> {
  const all: Repo[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await ghJson<Repo[]>(
      `${API}/users/${GH_USER}/repos?per_page=100&sort=pushed&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * Full recursive file listing for a repo's default branch.
 * `truncated` is set by GitHub for very large trees; we surface it so the caller
 * can warn rather than silently indexing a partial repo.
 */
export async function fetchRepoTree(
  repo: Repo,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const url = `${API}/repos/${GH_USER}/${repo.name}/git/trees/${encodeURIComponent(
    repo.default_branch,
  )}?recursive=1`;
  const data = await ghJson<{ tree?: TreeEntry[]; truncated?: boolean }>(url);
  return {
    entries: (data.tree ?? []).filter((e) => e.type === "blob"),
    truncated: data.truncated === true,
  };
}

export function rawUrl(repo: Repo, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${GH_USER}/${repo.name}/${repo.default_branch}/${encoded}`;
}

/** Permalink to the file on github.com, used as the citation URL. */
export function blobUrl(repo: Repo, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${repo.html_url}/blob/${repo.default_branch}/${encoded}`;
}

/** Fetch a file's raw text. Returns null if missing or not valid UTF-8 text. */
export async function fetchRawFile(repo: Repo, path: string): Promise<string | null> {
  try {
    const res = await withRetry(async () => {
      const r = await fetch(rawUrl(repo, path), { headers: { "user-agent": USER_AGENT } });
      if (!r.ok && (r.status === 429 || r.status >= 500)) {
        throw Object.assign(new Error(`raw ${r.status} for ${path}`), {
          $metadata: { httpStatusCode: r.status },
        });
      }
      return r;
    });
    if (!res.ok) return null;
    const text = await res.text();
    // A NUL byte means we grabbed something binary despite the extension filter.
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

const README_CANDIDATES = ["README.md", "readme.md", "README.MD", "Readme.md", "README.rst", "README"];

/** Fetch a repo README from the raw CDN. Returns "" if none exists. */
export async function fetchReadme(repo: Repo): Promise<string> {
  for (const file of README_CANDIDATES) {
    const text = await fetchRawFile(repo, file);
    if (text !== null && text.trim() !== "") return text;
  }
  return "";
}
