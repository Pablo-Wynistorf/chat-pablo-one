"use client";

import type { ChatSource } from "@/lib/types";
import type { VisitorContext } from "@/lib/visitor";
import MessageContent from "./MessageContent";
import VisitorCard from "./VisitorCard";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  /**
   * Set on the opening greeting only: what the request revealed about the
   * visitor, so the UI can show where the personal details came from.
   */
  visitor?: VisitorContext;
  /** True while this assistant turn is still streaming. */
  pending?: boolean;
  /**
   * True if a guardrail refused this turn. Blocked turns stay visible but are
   * excluded from the history sent on later requests, so one refusal doesn't
   * poison the rest of the conversation.
   */
  blocked?: boolean;
}

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** Pablo's monogram, so assistant turns read as coming from a person. */
function Avatar() {
  return (
    <div
      aria-hidden="true"
      className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-[0.8rem] font-semibold text-accent-fg shadow-bubble"
    >
      P
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="Pablo is typing">
      <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current" />
      <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current [animation-delay:0.2s]" />
      <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current [animation-delay:0.4s]" />
    </span>
  );
}

export default function ChatMessage({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";

  return (
    <div
      className={`flex w-full min-w-0 animate-fade-up gap-2.5 ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      {!isUser ? <Avatar /> : null}

      {/* w-full + max-w gives this column a DEFINITE width rather than a
          shrink-to-fit one. That matters for code blocks: a <pre> has no intrinsic
          width limit, so without a definite ancestor width the bubble grows to fit
          the longest line instead of letting the <pre> scroll. The bubbles inside
          still hug their content via items-start/items-end. */}
      <div
        className={`flex w-full min-w-0 max-w-[calc(100%-3rem)] flex-col gap-2 sm:max-w-[80%] ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        <div
          className={`min-w-0 break-words px-4 py-2.5 text-sm leading-relaxed shadow-bubble ${
            isUser
              ? "bubble-out rounded-2xl rounded-br-md"
              : "bubble-in rounded-2xl rounded-bl-md"
          } ${turn.blocked ? "opacity-80" : ""}`}
        >
          {turn.content ? (
            isUser ? (
              <span className="whitespace-pre-wrap">{turn.content}</span>
            ) : (
              <MessageContent content={turn.content} />
            )
          ) : turn.pending ? (
            <span className="text-muted">
              <TypingDots />
            </span>
          ) : null}
        </div>

        {/* Only once the greeting has finished streaming — popping in mid-sentence
            would pull focus away from the message itself. */}
        {!isUser && turn.visitor && !turn.pending ? <VisitorCard visitor={turn.visitor} /> : null}

        {!isUser && turn.sources && turn.sources.length > 0 ? (
          <div className="flex flex-col gap-1.5 pl-0.5">
            <span className="text-[0.7rem] font-medium uppercase tracking-wide text-faint">
              Sources
            </span>
            <div className="flex flex-wrap gap-1.5">
              {turn.sources.map((s) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={hostPath(s.url)}
                  className="chip inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted shadow-bubble"
                >
                  <span className="max-w-[14rem] truncate">{s.title}</span>
                  <span className="tabular-nums text-faint">{(s.score * 100).toFixed(0)}%</span>
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
