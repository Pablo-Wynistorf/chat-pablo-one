import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/http";
import { searchSite } from "@/lib/search";
import { estimateTokens, MAX_BODY_BYTES, MAX_INPUT_TOKENS } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SearchBody {
  query?: string;
  topPages?: number;
}

/** Upper bound on results per request, so a huge topPages can't be used to fan out. */
const MAX_TOP_PAGES = 25;

export async function POST(req: Request) {
  const parsed = await readJsonBody<SearchBody>(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const { query, topPages } = parsed.data;

  if (!query || typeof query !== "string" || query.trim() === "") {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  // Every query costs a Bedrock embedding call, so bound it like a chat message.
  const queryTokens = estimateTokens(query);
  if (queryTokens > MAX_INPUT_TOKENS) {
    return NextResponse.json(
      {
        error: `Query is too long (~${queryTokens} tokens, limit ${MAX_INPUT_TOKENS}).`,
      },
      { status: 413 },
    );
  }

  // Clamp rather than reject — a bad topPages shouldn't fail an otherwise fine query.
  let limit: number | undefined;
  if (topPages !== undefined) {
    if (typeof topPages !== "number" || !Number.isFinite(topPages)) {
      return NextResponse.json({ error: "topPages must be a number" }, { status: 400 });
    }
    limit = Math.min(MAX_TOP_PAGES, Math.max(1, Math.floor(topPages)));
  }

  try {
    const results = await searchSite(query, limit === undefined ? undefined : { topPages: limit });
    return NextResponse.json({ query, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
