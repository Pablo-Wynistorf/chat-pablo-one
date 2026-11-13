/**
 * Lambda entry point: API Gateway HTTP API (payload format 2.0) -> Request ->
 * route handler -> Response -> API Gateway result.
 *
 * Terraform handler: "index.handler" (dist/index.mjs at the package root).
 *
 * The route handlers produce streamed bodies, but an HTTP API integration always
 * buffers the Lambda response, so the body is collected here and returned in
 * one piece — the same end-to-end behaviour as the previous Lambda Web Adapter
 * setup behind the same API Gateway.
 */
import { route } from "./app";
import { drainBackground } from "./lib/background";

interface HttpApiEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: {
    domainName?: string;
    http: { method: string; sourceIp?: string };
  };
}

interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg\+xml)/i;

function toRequest(event: HttpApiEvent): Request {
  const method = event.requestContext.http.method.toUpperCase();
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  // API Gateway normally sets X-Forwarded-For itself; fall back to the socket IP
  // so clientIp() in lib/usage.ts always has something to key the limits on.
  const sourceIp = event.requestContext.http.sourceIp;
  if (!headers.has("x-forwarded-for") && sourceIp) headers.set("x-forwarded-for", sourceIp);

  const host = headers.get("host") ?? event.requestContext.domainName ?? "localhost";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${event.rawPath}${query}`;

  const hasBody = event.body !== undefined && event.body !== null && method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, "base64")
      : (event.body as string)
    : undefined;

  return new Request(url, { method, headers, body });
}

async function toResult(res: Response, isHead: boolean): Promise<HttpApiResult> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = res.headers.getSetCookie();

  const bytes = Buffer.from(await res.arrayBuffer());
  const isText = TEXT_TYPES.test(res.headers.get("content-type") ?? "text/plain");

  return {
    statusCode: res.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: isHead ? "" : isText ? bytes.toString("utf8") : bytes.toString("base64"),
    isBase64Encoded: !isHead && !isText,
  };
}

export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  try {
    const req = toRequest(event);
    const res = await route(req);
    const result = await toResult(res, req.method === "HEAD");
    // Usage writes queued when a stream closed must land before Lambda freezes.
    await drainBackground();
    return result;
  } catch (err) {
    console.error("Unhandled API error", err);
    await drainBackground();
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
      isBase64Encoded: false,
    };
  }
}
