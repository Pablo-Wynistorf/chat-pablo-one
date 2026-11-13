/**
 * Work that should finish after the response body is complete, e.g. recording
 * token usage once a streamed answer has closed.
 *
 * Lambda freezes the execution environment as soon as the handler returns, so a
 * bare `void promise` may never run (or run during some later invocation). The
 * handler awaits drainBackground() before returning; the response is buffered by
 * API Gateway anyway, so this only adds the duration of the pending writes.
 */
const pending = new Set<Promise<void>>();

export function background(task: Promise<unknown>, label = "background task"): void {
  const tracked: Promise<void> = task
    .then(() => undefined)
    .catch((err: unknown) => console.error(`${label} failed`, err))
    .finally(() => pending.delete(tracked));
  pending.add(tracked);
}

export async function drainBackground(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}
