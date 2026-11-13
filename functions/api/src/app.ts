/**
 * Route table shared by the Lambda handler (index.ts) and the local dev server
 * (dev.ts). Handlers take a Web-standard Request and return a Response, exactly
 * like the Next.js route handlers they were moved from.
 *
 * API Gateway only forwards the routes declared in terraform/api.tf, so the 404 /
 * 405 answers below mainly matter for local development.
 */
import * as chat from "./routes/chat";
import * as greeting from "./routes/greeting";
import * as search from "./routes/search";

type RouteHandler = (req: Request) => Promise<Response>;

const ROUTES: Record<string, Partial<Record<string, RouteHandler>>> = {
  "/api/chat": { POST: chat.POST },
  "/api/greeting": { GET: greeting.GET },
  "/api/search": { POST: search.POST },
};

export async function route(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const methods = ROUTES[pathname.replace(/\/+$/, "")];
  if (!methods) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // HEAD is answered by the GET handler with the body dropped by the caller.
  const method = req.method === "HEAD" ? "GET" : req.method;
  const handler = methods[method];
  if (!handler) {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: Object.keys(methods).join(", ") } },
    );
  }
  return handler(req);
}
