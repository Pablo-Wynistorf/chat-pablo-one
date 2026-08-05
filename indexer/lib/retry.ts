/**
 * Exponential backoff retry helper, primarily for Bedrock `ThrottlingException`.
 *
 * Retries on throttling / transient 5xx style errors. Anything else (e.g.
 * `AccessDeniedException` from missing Bedrock model access) is rethrown
 * immediately so the caller can fail loudly.
 */

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const RETRYABLE_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "ModelNotReadyException",
]);

function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: string }).name ?? "";
  const httpStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  if (RETRYABLE_NAMES.has(name)) return true;
  if (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)) return true;
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 20_000;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryable(err)) {
        throw err;
      }
      // Full jitter exponential backoff.
      const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(Math.random() * expDelay);
      opts.onRetry?.(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }
}
