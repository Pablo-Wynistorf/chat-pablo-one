import { streamGreeting } from "@/lib/chat";
import {
  clientIp,
  getIpDailyUsage,
  IP_DAILY_LIMIT,
  isIpBlocked,
  isOverBudget,
  recordUsage,
} from "@/lib/usage";
import { fallbackGreeting, readVisitor, type VisitorContext } from "@/lib/visitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The detected visitor picture rides back on a header so the UI can show the
 * receipts under the greeting. It has to be a header rather than part of the
 * body because the body is a plain-text stream the client appends verbatim.
 * Headers are latin-1 only, hence the encodeURIComponent.
 */
function visitorHeader(v: VisitorContext): Record<string, string> {
  try {
    return { "x-visitor": encodeURIComponent(JSON.stringify(v)) };
  } catch {
    return {};
  }
}

// A fresh, AI-generated first-person greeting from Pablo on every page load,
// personalised from whatever this single request reveals about the visitor.
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  // Never let the personalisation layer break the page: a failed geo lookup or a
  // malformed header should cost us a detail, not the greeting.
  let visitor: VisitorContext = {};
  try {
    visitor = await readVisitor(req);
  } catch (err) {
    console.error("visitor detection failed", err);
  }
  const headers = visitorHeader(visitor);

  // The static greeting response, reused by every "don't spend on the model" path
  // below. Still personalised (time of day, place) — just not improvised.
  const staticGreeting = () =>
    new Response(fallbackGreeting(visitor), {
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });

  const ip = clientIp(req);

  // Serve the free static greeting instead of spending on the model when any of:
  //   - the IP is blocked for repeated abuse,
  //   - the app is over its global daily budget, or
  //   - this IP has already used up its daily message allowance.
  // The budget cap is the real backstop against greeting spam: every greeting's
  // tokens are recorded below, so a reload flood just pushes spend to the cap and
  // from then on everyone gets the static greeting — no runaway cost. The per-IP
  // check means a visitor who can no longer chat today doesn't get a fresh
  // improvised greeting either: once they're out of messages, the greeting is
  // static too. It's a read (getIpDailyUsage), not recordIpMessage, so loading
  // the page never spends a message from the allowance. All checks fail open so a
  // tracking error can't break the page.
  try {
    if (
      (await isIpBlocked(ip)) ||
      (await isOverBudget()) ||
      (await getIpDailyUsage(ip)).calls >= IP_DAILY_LIMIT
    ) {
      return staticGreeting();
    }
  } catch (err) {
    console.error("greeting guard check failed", err);
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of streamGreeting(usage, visitor)) {
          controller.enqueue(encoder.encode(delta));
        }
      } catch {
        controller.enqueue(encoder.encode(fallbackGreeting(visitor)));
      } finally {
        controller.close();
        // Count the greeting's tokens in the same fields as a chat turn: the global
        // cost#<day> item (which the budget cap reads) and this IP's daily item.
        // This is what makes greeting spam self-limiting — it pushes spend toward
        // the daily cap like any other call.
        void recordUsage(usage, ip).catch((e) => console.error("recordUsage failed", e));
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
