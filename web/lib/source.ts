/**
 * Live source-file fetch for pinpoint code questions.
 *
 * Retrieval only stores a chunk of each file (capped, and possibly the wrong part
 * for a very specific "how exactly is X implemented" question). When the top match
 * is confidently a single code file, we fetch that file WHOLE from the GitHub raw
 * CDN and hand the model the real, complete source instead of one excerpt — so it
 * answers from actual code rather than filling gaps.
 *
 * SECURITY: the only URLs ever fetched are ones derived from a code chunk's own
 * stored `url` metadata (a github.com blob permalink we generated at index time),
 * transformed to the raw CDN. Both the input host (github.com) and the output host
 * (raw.githubusercontent.com) are asserted, so a crafted metadata value can't turn
 * this into a server-side request against an arbitrary host.
 */

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const RAW_HOST = "raw.githubusercontent.com";

/**
 * Turn a github.com blob permalink into its raw-CDN equivalent, or null if the
 * input isn't a blob URL on github.com.
 *
 *   https://github.com/O/R/blob/main/src/a.ts
 *   -> https://raw.githubusercontent.com/O/R/main/src/a.ts
 */
export function rawUrlFromBlob(blobUrl: string | undefined): string | null {
  if (!blobUrl) return null;
  let u: URL;
  try {
    u = new URL(blobUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !GITHUB_HOSTS.has(u.hostname)) return null;

  // pathname (already percent-encoded): /owner/repo/blob/branch/<path…>
  // /owner/repo/blob/branch/<path…>  ->  parts[2] is the "blob" segment.
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") return null;

  const [owner, repo, , branch, ...rest] = parts;
  if (!owner || !repo || !branch || rest.length === 0) return null;

  // Segments stay percent-encoded (they came from an encoded pathname).
  return `https://${RAW_HOST}/${owner}/${repo}/${branch}/${rest.join("/")}`;
}

export interface FetchedFile {
  text: string;
  /** True when the file was longer than maxChars and had to be clipped. */
  truncated: boolean;
  bytes: number;
}

/**
 * Fetch a raw source file, bounded by a timeout and a size cap. Returns null on
 * any failure — a missing file or a slow CDN must never break the answer, it just
 * falls back to the stored chunks.
 */
export async function fetchSourceFile(
  rawUrl: string,
  opts: { maxChars: number; timeoutMs: number },
): Promise<FetchedFile | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  // Defence in depth: only ever the raw CDN, only https.
  if (u.protocol !== "https:" || u.hostname !== RAW_HOST) return null;

  try {
    const res = await fetch(rawUrl, {
      cache: "no-store",
      redirect: "error", // don't follow a redirect off the raw host
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { "user-agent": "pablo-one-web/1.0", accept: "text/plain,*/*" },
    });
    if (!res.ok) return null;

    // Reject obviously huge or binary responses before reading the body.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > opts.maxChars * 8) return null;

    const raw = await res.text();
    // A NUL byte means binary slipped through despite the extension filter.
    if (raw.includes("\u0000")) return null;

    const truncated = raw.length > opts.maxChars;
    return {
      text: truncated ? raw.slice(0, opts.maxChars) : raw,
      truncated,
      bytes: raw.length,
    };
  } catch {
    return null; // timeout, DNS, redirect-off-host, network error
  }
}
