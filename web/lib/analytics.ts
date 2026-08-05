/**
 * Site-wide unique-visitor counter, backed by count.onedns.ch.
 *
 * MUST run in the browser. The service counts whoever calls it, so posting this
 * from the web Lambda would register the *server* as the single unique visitor
 * and the number would never move. That's why this is a client module and the
 * count reaches the greeting API as a query parameter rather than being fetched
 * server-side.
 *
 * What it measures: the number of unique visitors the whole site has had — not
 * how many times this particular person has been here. Those are different
 * facts; per-visitor repeat detection stays in localStorage (see page.tsx),
 * because a site-wide total can't answer it.
 *
 * Every failure mode (offline, CORS, timeout, 5xx, malformed body) resolves to
 * undefined. The counter is decoration; it must never break the page.
 */

const ENDPOINT = "https://count.onedns.ch";

/** Default cap on how long the greeting may wait for the counter. */
const DEFAULT_TIMEOUT_MS = 600;

export interface AnalyticsTrackerApi {
  /** Last known site-wide count, 0 until the first successful refresh. */
  count: number;
  /** POST the endpoint, update `count`, and return it. */
  refresh(): Promise<number>;
}

declare global {
  // eslint-disable-next-line no-var
  var AnalyticsTracker: AnalyticsTrackerApi | undefined;
}

async function post(timeoutMs: number): Promise<number | undefined> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      // The published snippet has no timeout, so a hung request leaves the count
      // at 0 forever and — here — would stall the greeting behind it.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { count?: unknown };
    return typeof data.count === "number" && Number.isFinite(data.count) && data.count >= 0
      ? Math.floor(data.count)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register this visit and return the site-wide unique-visitor total.
 * Resolves to undefined rather than throwing if the counter is unreachable.
 */
export async function countVisit(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number | undefined> {
  if (typeof window === "undefined") return undefined;

  const count = await post(timeoutMs);

  // Expose the same surface the AnalyticsTracker guide documents, so the count is
  // reachable from the console or any other script on the page as
  // `AnalyticsTracker.count` / `AnalyticsTracker.refresh()`.
  const existing = window.AnalyticsTracker;
  if (existing) {
    if (count !== undefined) existing.count = count;
  } else {
    window.AnalyticsTracker = {
      count: count ?? 0,
      async refresh() {
        const next = await post(DEFAULT_TIMEOUT_MS);
        if (next !== undefined) this.count = next;
        return this.count;
      },
    };
  }

  return count;
}
