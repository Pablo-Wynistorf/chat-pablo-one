"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

/**
 * Soft character cap, matching the server's default MAX_INPUT_TOKENS (400) at
 * roughly 4 chars/token. This is only for feedback — `/api/chat` re-checks every
 * limit and is the authoritative gate.
 */
const MAX_CHARS = 1600;
/** Start showing the counter once the user is close to the cap. */
const COUNTER_AT = MAX_CHARS - 200;
/** Grow the textarea up to this height, then scroll inside it. */
const MAX_HEIGHT_PX = 160;

export default function ChatComposer({ value, onChange, onSubmit, disabled }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const remaining = MAX_CHARS - value.length;
  const overCap = remaining < 0;

  // Auto-grow with the content. Reset to `auto` first so the box can also shrink
  // back down when text is deleted.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const canSend = !disabled && value.trim() !== "" && !overCap;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSend) onSubmit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter makes a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full items-end gap-2">
      <div className="relative min-w-0 flex-1">
        <label htmlFor="chat-input" className="sr-only">
          Your message
        </label>
        <textarea
          id="chat-input"
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything…"
          aria-invalid={overCap}
          className="field scroll-slim w-full resize-none rounded-2xl px-4 py-3 pr-16 text-sm shadow-bubble focus:outline-none"
        />
        {value.length >= COUNTER_AT ? (
          <span
            aria-live="polite"
            className={`pointer-events-none absolute bottom-2.5 right-3 text-[0.7rem] tabular-nums ${
              overCap ? "text-red-500" : "text-faint"
            }`}
          >
            {remaining}
          </span>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send message"
        className="btn-primary grid h-[46px] w-[46px] shrink-0 place-items-center rounded-2xl shadow-bubble disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[18px] w-[18px]"
          aria-hidden="true"
        >
          <path d="M4.5 12h13m0 0-5-5m5 5-5 5" />
        </svg>
      </button>
    </form>
  );
}
