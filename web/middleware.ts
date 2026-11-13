import { NextResponse, type NextRequest } from "next/server";

/**
 * CORS for the public API, so the portfolio at pablo.one can embed the chat.
 *
 * The API is anonymous (no cookies, no auth) and already reachable by any
 * non-browser client, so this allowlist only decides which *websites* may call
 * it from a visitor's browser. Cost and abuse limits stay in the route handlers
 * (per-IP daily limit, global budget), which apply to every caller equally.
 *
 * x-sources and x-visitor are exposed because the chat UI reads them; browsers
 * hide non-safelisted response headers from cross-origin scripts by default.
 */
const ALLOWED_ORIGINS = new Set([
  "https://pablo.one",
  "https://www.pablo.one",
  // local development of the portfolio (Vite dev server and preview)
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://localhost:4173",
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "x-sources, x-visitor",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const allowed = origin !== null && ALLOWED_ORIGINS.has(origin);

  if (req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: allowed ? corsHeaders(origin) : { Vary: "Origin" },
    });
  }

  const res = NextResponse.next();
  if (allowed) {
    for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
  }
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
