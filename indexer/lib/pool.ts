/**
 * Fixed-size concurrency pool. Used by the ingest scripts (many small HTTP
 * fetches) and by the embedder (many small Bedrock calls).
 */

/** Runs `worker` over `items` with a bounded concurrency pool, preserving order. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}
