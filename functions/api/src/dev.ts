/**
 * Local development server for the API: `npm run dev` (port 3001 by default).
 * The frontend's `next dev` proxies /api/* here (see frontends/web/next.config.mjs).
 *
 * Unlike Lambda behind API Gateway, this streams response bodies as they are
 * produced. AWS credentials come from your local profile; resource names come
 * from .env.local in this folder (see .env.local.example). Not part of the
 * Lambda bundle.
 */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { route } from "./app";
import { drainBackground } from "./lib/background";

const PORT = Number.parseInt(process.env.API_DEV_PORT ?? "3001", 10);

createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    if (!headers.has("x-forwarded-for") && req.socket.remoteAddress) {
      headers.set("x-forwarded-for", req.socket.remoteAddress);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
      // Required by Node's fetch implementation for streamed request bodies.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);

    const response = await route(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && method !== "HEAD") {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
    await drainBackground();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
}).listen(PORT, () => console.log(`API dev server on http://localhost:${PORT}`));
