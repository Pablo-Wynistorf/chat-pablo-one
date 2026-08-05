"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChatComposer from "@/components/ChatComposer";
import ChatMessage, { type ChatTurn } from "@/components/ChatMessage";
import SuggestionGrid from "@/components/SuggestionGrid";
import ThemeToggle from "@/components/ThemeToggle";
import { countVisit } from "@/lib/analytics";
import { BLOCKED_SENTINEL, type ChatSource } from "@/lib/types";
import type { VisitorContext } from "@/lib/visitor";

const VISIT_COUNTER_KEY = "pablo.one.visits";

/** Shown in place of a guardrail-refused turn. See where it's used for why. */
const BLOCKED_MESSAGE =
  "That one's outside what I can help with here — ask me about my work, my projects, my certifications, or the events I've worked on.";

/**
 * The things only the browser knows, attached to the greeting request itself so
 * it stays a single round-trip.
 *
 * Headers alone can't supply these: the IP's timezone is wrong behind a VPN, and
 * a same-origin fetch's `Referer` is this page — not the site that sent them here.
 * Every value is re-validated and bounded server-side (see lib/visitor.ts).
 */
function browserSignals(opts: { trackVisit?: boolean } = {}): URLSearchParams {
  const { trackVisit = true } = opts;
  const p = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  };

  // Each probe is guarded separately: one unsupported API shouldn't cost us the rest.
  try {
    set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    /* no Intl timezone */
  }
  try {
    set("lang", navigator.language);
    set("cores", navigator.hardwareConcurrency);
    // Chromium-only, and absent from the TS DOM lib.
    set("mem", (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  } catch {
    /* no navigator details */
  }
  try {
    set("sw", window.screen.width);
    set("sh", window.screen.height);
    set("dpr", Math.round(window.devicePixelRatio * 100) / 100);
  } catch {
    /* no screen details */
  }
  try {
    set("dark", window.matchMedia("(prefers-color-scheme: dark)").matches ? "1" : "0");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) set("rm", "1");
  } catch {
    /* no matchMedia */
  }
  try {
    set("ref", document.referrer);
  } catch {
    /* no referrer */
  }

  // How many times THIS browser has been here. Separate from the site-wide total
  // from count.onedns.ch: a global unique-visitor count can't tell us whether this
  // particular person is coming back, and localStorage is the only client-side way
  // to know. Used purely for "welcome back". Skipped for an in-session "New Chat"
  // so restarting the conversation doesn't inflate the return-visitor count.
  try {
    const prev = Number(window.localStorage.getItem(VISIT_COUNTER_KEY) ?? "0");
    const seen = Number.isFinite(prev) && prev > 0 ? Math.min(prev, 9999) : 0;
    set("visits", seen);
    if (trackVisit) window.localStorage.setItem(VISIT_COUNTER_KEY, String(seen + 1));
  } catch {
    /* private mode / storage disabled */
  }

  return p;
}

/** The server's view of this visitor, echoed back so the UI can show its working. */
function readVisitorHeader(res: Response): VisitorContext | undefined {
  const raw = res.headers.get("x-visitor");
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw)) as VisitorContext;
  } catch {
    return undefined;
  }
}

export default function Home() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const [siteVisitors, setSiteVisitors] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const greetOnce = useRef(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  // Streams a fresh AI-generated greeting from Pablo as the first (and only) turn.
  // `trackVisit` is true on first load and false for an in-session "New Chat", so
  // restarting doesn't re-count the visit or re-increment the return counter.
  const runGreeting = useCallback(async (opts: { trackVisit?: boolean } = {}) => {
    const { trackVisit = true } = opts;

    setGreeted(false);
    setTurns([{ role: "assistant", content: "", pending: true }]);

    // Register the visit and get the site-wide total before asking for the
    // greeting, so Pablo can mention it. countVisit is capped at ~600ms and
    // resolves to undefined on any failure, so a slow or unreachable counter
    // delays the first message slightly but can never block it. On a New Chat we
    // skip the network round-trip and reuse the total we already have.
    let total: number | undefined;
    if (trackVisit) {
      total = await countVisit();
      if (total !== undefined) setSiteVisitors(total);
    } else {
      total = siteVisitors ?? undefined;
    }

    const params = browserSignals({ trackVisit });
    if (total !== undefined) params.set("total", String(total));

    try {
      const res = await fetch(`/api/greeting?${params.toString()}`);
      if (!res.ok || !res.body) throw new Error("greeting failed");
      const visitor = readVisitorHeader(res);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setTurns([{ role: "assistant", content: acc, pending: true, visitor }]);
      }
      setTurns([{ role: "assistant", content: acc.trim(), pending: false, visitor }]);
    } catch {
      setTurns([
        {
          role: "assistant",
          content: "Hi, I'm Pablo 👋 Ask me anything about my work, projects, or certifications!",
          pending: false,
        },
      ]);
    } finally {
      setGreeted(true);
    }
  }, [siteVisitors]);

  // On load, greet once. The ref guards against StrictMode's double-invoke.
  useEffect(() => {
    if (greetOnce.current) return;
    greetOnce.current = true;
    void runGreeting({ trackVisit: true });
    // Intentionally run once on mount; runGreeting is stable enough for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the transcript and start over with a fresh greeting, without a reload.
  const newChat = useCallback(() => {
    if (busy) return;
    setInput("");
    void runGreeting({ trackVisit: false });
  }, [busy, runGreeting]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (question === "" || busy) return;

      setInput("");
      setBusy(true);

      // Build the history we send to the API from the turns *before* this one,
      // skipping any turn a guardrail refused. Bedrock guardrails re-score the
      // whole conversation, so replaying a blocked question would block this
      // one as well.
      const history = [
        ...turns.filter((t) => !t.blocked).map((t) => ({ role: t.role, content: t.content })),
        { role: "user" as const, content: question },
      ];

      // Optimistically add the user turn + a pending assistant turn.
      setTurns((prev) => [
        ...prev,
        { role: "user", content: question },
        { role: "assistant", content: "", pending: true },
      ]);

      // navigator.language, so the answer's fallback language matches the one the
      // greeting used. Accept-Language alone disagrees with it often enough to
      // matter (English UI, Swiss region -> "de-CH" leads that header).
      let langQuery = "";
      try {
        langQuery = `?lang=${encodeURIComponent(navigator.language)}`;
      } catch {
        /* no navigator.language */
      }

      try {
        const res = await fetch(`/api/chat${langQuery}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history }),
        });

        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Request failed (${res.status})`);
        }

        // Sources arrive up front in a header.
        let sources: ChatSource[] = [];
        const raw = res.headers.get("x-sources");
        if (raw) {
          try {
            sources = JSON.parse(decodeURIComponent(raw)) as ChatSource[];
          } catch {
            /* ignore malformed */
          }
        }
        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: "", pending: true, sources };
          return next;
        });

        // Stream the answer body, appending deltas live.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setTurns((prev) => {
            const next = [...prev];
            next[next.length - 1] = {
              role: "assistant",
              // Hide the control sentinel so it never flashes mid-stream.
              content: acc.split(BLOCKED_SENTINEL).join(""),
              pending: true,
              sources,
            };
            return next;
          });
        }

        // A trailing sentinel means a guardrail refused this exchange. Strip it
        // and flag BOTH turns: the question is what tripped the guardrail, so
        // keeping either one in history would re-trip it next time.
        const blocked = acc.includes(BLOCKED_SENTINEL);
        const answer = blocked ? acc.split(BLOCKED_SENTINEL).join("").trim() : acc;

        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            // When a guardrail intervenes on the OUTPUT it doesn't discard what was
            // already generated — Bedrock appends the refusal to it, so the bubble
            // ends up showing half an answer followed by "Thanks for asking!". There
            // is no reliable way to split the two client-side, so a blocked turn is
            // replaced wholesale with one clean refusal.
            content: blocked ? BLOCKED_MESSAGE : answer || "(no answer)",
            pending: false,
            sources: blocked ? undefined : sources,
            blocked,
          };
          if (blocked && next.length >= 2) {
            const userTurn = next[next.length - 2]!;
            if (userTurn.role === "user") {
              next[next.length - 2] = { ...userTurn, blocked: true };
            }
          }
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Something went wrong";
        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: `⚠️ ${msg}`, pending: false };
          return next;
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, turns],
  );

  const noUserYet = !turns.some((t) => t.role === "user");

  return (
    // Full-width column. Each row centres its own max-w-3xl content, rather than
    // constraining <main> itself, so the transcript's scrollbar lands at the window
    // edge where it belongs instead of floating at the right edge of a 768px column.
    <main className="flex h-[100dvh] flex-col">
      {/* The header never scrolls: only the transcript below is a scroll container,
          so this stays put without needing `sticky`. */}
      <header className="mx-auto w-full max-w-3xl border-b border-line/60 px-4 pb-3 pt-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-fg shadow-bubble"
            >
              P
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
                Chat with me
              </h1>
              <p className="truncate text-xs text-faint">
                Pablo Wynistorf · IT technician · Cloud &amp; AWS · Switzerland
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={newChat}
              disabled={busy}
              title="Start a new chat"
              aria-label="Start a new chat"
              className="inline-flex items-center gap-1.5 rounded-full border border-line/60 px-3 py-1.5 text-xs font-medium text-faint transition hover:bg-accent/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="hidden sm:inline">New chat</span>
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* overflow-x-hidden is explicit: a lone `overflow-y-auto` computes overflow-x
          to `auto` too, which let a wide code block scroll the whole pane sideways.
          Wide code scrolls inside its own block instead (see MessageContent). */}
      <div ref={scrollRef} className="scroll-slim min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* min-h-full + justify-end grows the conversation up from the composer.
            Top-anchoring left a large dead gap between a short transcript and the
            input; this way spare room collapses above the first message, which is
            also where every other chat client puts it. Once the transcript is
            taller than the pane it simply scrolls as normal. */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl min-w-0 flex-col justify-end gap-4 px-4 py-4">
          {turns.map((t, i) => (
            <ChatMessage key={i} turn={t} />
          ))}

          {/* Once the greeting is in, offer some starter questions until the
              visitor asks their own. */}
          {greeted && noUserYet ? <SuggestionGrid onPick={send} disabled={busy} /> : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-1">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={() => send(input)}
          disabled={busy}
        />
        <p className="mt-2.5 text-center text-[0.7rem] text-faint">
          This is an AI answering as Pablo, grounded in his content — it may be imperfect.
          {siteVisitors !== null ? (
            <>
              {" · "}
              <span title="Unique visitors to this site" className="tabular-nums">
                {siteVisitors.toLocaleString()} visitors
              </span>
            </>
          ) : null}
        </p>
      </div>
    </main>
  );
}
