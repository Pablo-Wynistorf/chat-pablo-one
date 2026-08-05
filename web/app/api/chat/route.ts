import { retrieve, streamAnswer } from "@/lib/chat";
import { readLanguage } from "@/lib/visitor";
import { readJsonBody } from "@/lib/http";
import { BLOCKED_SENTINEL, type ChatMessage } from "@/lib/types";
import {
  clientIp,
  estimateTokens,
  isIpBlocked,
  isOverBudget,
  IP_DAILY_LIMIT,
  MAX_BODY_BYTES,
  MAX_CONVERSATION_TOKENS,
  MAX_HISTORY_MESSAGES,
  MAX_INPUT_TOKENS,
  noteDailyLimitReached,
  recordIpMessage,
  recordUsage,
} from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatBody {
  messages?: ChatMessage[];
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (typeof m !== "object" || m === null) return false;
  const msg = m as ChatMessage;
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  if (typeof msg.content !== "string") return false;
  if (msg.blocked !== undefined && typeof msg.blocked !== "boolean") return false;
  return true;
}

export async function POST(req: Request) {
  // 0) Bound the raw request before parsing it.
  const parsed = await readJsonBody<ChatBody>(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  const rawMessages = parsed.data.messages;
  if (!Array.isArray(rawMessages)) {
    return Response.json({ error: "messages must be an array" }, { status: 400 });
  }

  // 1) Cap history length. The client sends the whole conversation, so an
  //    unbounded array is an unbounded Bedrock bill.
  if (rawMessages.length > MAX_HISTORY_MESSAGES) {
    return Response.json(
      {
        error: `Conversation too long (${rawMessages.length} messages, limit ${MAX_HISTORY_MESSAGES}). Please start a new chat.`,
      },
      { status: 413 },
    );
  }

  const all = rawMessages.filter(isValidMessage);
  if (all.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400 });
  }

  // Drop guardrail-blocked turns up front: they're never sent to Bedrock, so
  // they shouldn't count toward the size limits or be used for retrieval either.
  const messages = all.filter((m) => !m.blocked);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return Response.json({ error: "no user message found" }, { status: 400 });
  }

  // 2) Per-message limit on the new question.
  const inputTokens = estimateTokens(lastUser.content);
  if (inputTokens > MAX_INPUT_TOKENS) {
    return Response.json(
      {
        error: `Your message is too long (~${inputTokens} tokens, limit ${MAX_INPUT_TOKENS}). Please shorten it.`,
      },
      { status: 413 },
    );
  }

  // 3) Limit on the conversation as a whole. Without this, padding the history
  //    with many individually-legal turns bypasses the per-message check.
  const conversationTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (conversationTokens > MAX_CONVERSATION_TOKENS) {
    return Response.json(
      {
        error: `Conversation too long (~${conversationTokens} tokens, limit ${MAX_CONVERSATION_TOKENS}). Please start a new chat.`,
      },
      { status: 413 },
    );
  }

  // 4) Daily cost budget — stop generating once the day's spend is used up.
  try {
    if (await isOverBudget()) {
      return Response.json(
        {
          error:
            "I've hit my daily usage limit for AI responses. Please come back tomorrow — thanks for understanding!",
        },
        { status: 429 },
      );
    }
  } catch (err) {
    // Fail open on tracking errors so the app still works, but log it.
    console.error("budget check failed", err);
  }

  // 5) Per-IP abuse controls.
  const ip = clientIp(req);

  // 5a) Hard block: an IP that maxed out the daily limit on
  //     BLOCK_AFTER_CONSECUTIVE_DAYS days in a row is refused outright.
  try {
    if (await isIpBlocked(ip)) {
      return Response.json(
        { error: "Access from this network has been blocked due to repeated overuse." },
        { status: 403 },
      );
    }
  } catch (err) {
    console.error("ip block check failed", err);
  }

  // 5b) Daily message limit. recordIpMessage is atomic, so exactly one request per
  //     day sees the returned count equal the limit — that one advances the
  //     consecutive-day streak (and may trip the block for future days).
  try {
    const count = await recordIpMessage(ip);
    if (count === IP_DAILY_LIMIT) {
      await noteDailyLimitReached(ip).catch((e) => console.error("streak update failed", e));
    }
    if (count > IP_DAILY_LIMIT) {
      return Response.json(
        {
          error: `You've reached the daily limit of ${IP_DAILY_LIMIT} messages. Please try again tomorrow.`,
        },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error("ip limit check failed", err);
  }

  // Header-only, so this costs nothing. Used purely as the tie-breaker when a
  // message is too short for the model to identify its language — the answer
  // otherwise follows whatever language the visitor actually wrote in.
  const browserLanguage = readLanguage(req)?.name;

  try {
    const { context, sources } = await retrieve(lastUser.content);

    const usage = { inputTokens: 0, outputTokens: 0, guardrailBlocked: false };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const delta of streamAnswer(messages, context, usage, browserLanguage)) {
            controller.enqueue(encoder.encode(delta));
          }
          // Tell the client this turn was refused so it can exclude both this
          // question and the refusal from future requests.
          if (usage.guardrailBlocked) {
            controller.enqueue(encoder.encode(BLOCKED_SENTINEL));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Generation failed";
          controller.enqueue(encoder.encode(`\n\n[error: ${msg}]`));
        } finally {
          controller.close();
          // Record actual spend (chat tokens + the query-embedding tokens) against
          // both the global daily counter and this IP's daily counter.
          void recordUsage(
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              embedTokens: inputTokens,
            },
            ip,
          ).catch((e) => console.error("recordUsage failed", e));
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "x-sources": encodeURIComponent(JSON.stringify(sources)),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
