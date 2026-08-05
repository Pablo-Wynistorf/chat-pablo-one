/**
 * Request-body helpers for the API routes.
 *
 * `req.json()` will happily buffer and parse a body of any size, which means an
 * unauthenticated caller can push arbitrary memory into the Lambda before a
 * single validation rule runs. Everything here exists to bound the request
 * *before* it costs us anything.
 */

export interface BodyOk<T> {
  ok: true;
  data: T;
}

export interface BodyErr {
  ok: false;
  status: number;
  error: string;
}

export type BodyResult<T> = BodyOk<T> | BodyErr;

/**
 * Read and JSON-parse a request body, refusing anything over `maxBytes`.
 *
 * The declared Content-Length is checked first as a cheap reject, but the stream
 * is also counted as it arrives — a caller can omit or lie about the header, so
 * the header alone is not a limit.
 */
export async function readJsonBody<T>(
  req: Request,
  maxBytes: number,
): Promise<BodyResult<T>> {
  const tooLarge: BodyErr = {
    ok: false,
    status: 413,
    error: `Request body too large (limit ${Math.floor(maxBytes / 1024)} KB).`,
  };

  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return tooLarge;
  }

  if (!req.body) {
    return { ok: false, status: 400, error: "Request body is required" };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling as soon as the cap is passed — don't buffer the rest.
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "Could not read request body" };
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(buf)) as T };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" };
  }
}
