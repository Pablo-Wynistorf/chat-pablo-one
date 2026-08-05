"use client";

import { useState, type JSX } from "react";

/**
 * Renders an assistant message: fenced code blocks, then light markdown for the
 * prose around them.
 *
 * Three things make this necessary now that real source code is indexed:
 *  - Code must keep its indentation and line breaks, so the prose cleanup
 *    (which collapses runs of whitespace and strips URLs) must NOT touch it.
 *  - A ``` fence should become a real code block, not literal backticks.
 *  - The model reliably answers "what do you do in your free time" with a
 *    numbered list of `**Bold**:` items. Rendered as plain text that reads as
 *    literal asterisks, so prose needs a small block/inline markdown pass too.
 */

type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string; unterminated: boolean };

const FENCE = /```([A-Za-z0-9_+#-]*)[ \t]*\r?\n?/g;

/**
 * Split a message into prose and fenced-code segments.
 *
 * While a reply is still streaming the closing fence hasn't arrived yet, so an
 * unterminated fence is treated as code-so-far. That way the block renders
 * progressively instead of flashing raw backticks at the reader.
 */
export function parseSegments(input: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (;;) {
    FENCE.lastIndex = cursor;
    const open = FENCE.exec(input);
    if (!open) break;

    if (open.index > cursor) {
      segments.push({ kind: "text", text: input.slice(cursor, open.index) });
    }

    const bodyStart = open.index + open[0].length;
    const close = input.indexOf("```", bodyStart);
    const lang = open[1] ?? "";

    if (close === -1) {
      segments.push({ kind: "code", lang, code: input.slice(bodyStart), unterminated: true });
      return segments;
    }

    segments.push({
      kind: "code",
      lang,
      code: input.slice(bodyStart, close),
      unterminated: false,
    });
    cursor = close + 3;
  }

  if (cursor < input.length) segments.push({ kind: "text", text: input.slice(cursor) });
  return segments;
}

/**
 * The model sometimes pastes raw URLs or markdown links even when asked not to.
 * Clickable sources are rendered separately, so strip link clutter from prose.
 * Only ever called on text segments — never on code.
 */
function cleanProse(text: string): string {
  return (
    text
      // Strip STRAY bare URLs, but not a markdown link's target: the negative
      // lookbehind protects the "](…" of a real `[label](url)`, which renderInline
      // turns into a clickable link. Markdown links are now kept, not flattened.
      .replace(/(?<!]\()\bhttps?:\/\/\S+/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([.,;:!?])/g, "$1") // space before punctuation left by removals
      .replace(/\(\s*\)/g, "") // empty parens
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Hosts an inline link may point at. Links are model output, and retrieved content
 * could try to smuggle a hostile URL, so anything off this list renders as plain
 * text (label only) — never a clickable link.
 */
const ALLOWED_LINK_HOSTS = new Set([
  "pablo.one",
  "www.pablo.one",
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "linkedin.com",
  "www.linkedin.com",
  "credly.com",
  "www.credly.com",
]);

function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (!ALLOWED_LINK_HOSTS.has(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// --- inline markdown --------------------------------------------------------

/**
 * Inline markdown: `[label](url)`, `**bold**`, `*italic*` and `` `code` ``.
 *
 * A single scanning regex (not `split`) because a link carries its own inner
 * groups, which would corrupt a split-on-capture approach. Order in the alternation
 * matters: link first, then bold before italic so `**` wins over `*`.
 *
 * Deliberately narrow:
 *  - `_underscore_` emphasis is NOT supported — it would mangle snake_case
 *    identifiers, which this corpus is full of.
 *  - italic requires a non-space first character so "2 * 3 * 4" isn't swallowed.
 */
const INLINE_TOKEN =
  /\[[^\]\n]+\]\([^()\s]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*/g;
const LINK_TOKEN = /^\[([^\]]+)\]\(([^()\s]+)\)$/;

function renderInline(text: string, keyPrefix: string): (JSX.Element | string)[] {
  const out: (JSX.Element | string)[] = [];
  let last = 0;
  let i = 0;

  for (const m of text.matchAll(INLINE_TOKEN)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + tok.length;
    const key = `${keyPrefix}-${i++}`;

    const link = LINK_TOKEN.exec(tok);
    if (link) {
      const label = link[1]!;
      const href = safeHref(link[2]!);
      // Off-allowlist or malformed URL: keep the words, drop the link.
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-2 transition hover:decoration-accent"
          >
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={key} className="font-semibold text-fg">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="code-inline text-fg">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <em key={key} className="italic">
          {tok.slice(1, -1)}
        </em>,
      );
    }
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

// --- block markdown --------------------------------------------------------

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] };

const ORDERED_ITEM = /^\s{0,3}(\d{1,2})[.)]\s+(.*)$/;
const UNORDERED_ITEM = /^\s{0,3}[-*•]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;

/**
 * Group lines into paragraphs, headings and lists.
 *
 * Line-based rather than splitting on blank lines, because the model puts a blank
 * line *between* list items — so a blank-line split would produce one list per
 * item. Here a blank line keeps an open list open; only a non-indented,
 * non-item line closes it.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: "p", text: para.join("\n") });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ...list });
      list = null;
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");

    if (line.trim() === "") {
      // A blank line ends a paragraph but not a list: items are usually spaced out.
      flushPara();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "h", text: heading[1]! });
      continue;
    }

    const ordered = ORDERED_ITEM.exec(line);
    if (ordered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, start: Number(ordered[1]), items: [] };
      }
      list.items.push(ordered[2]!);
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    if (unordered) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, start: 1, items: [] };
      }
      list.items.push(unordered[1]!);
      continue;
    }

    // Indented continuation of the previous list item (wrapped text).
    if (list && /^\s{2,}/.test(raw) && list.items.length > 0) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  return blocks;
}

function Prose({ text, idx }: { text: string; idx: number }) {
  const blocks = parseBlocks(text);

  return (
    <>
      {blocks.map((b, i) => {
        const key = `${idx}-${i}`;

        if (b.kind === "h") {
          return (
            <p key={key} className="mt-2 font-semibold text-fg first:mt-0">
              {renderInline(b.text, key)}
            </p>
          );
        }

        if (b.kind === "list") {
          const ListTag = b.ordered ? "ol" : "ul";
          return (
            <ListTag
              key={key}
              start={b.ordered ? b.start : undefined}
              className={`my-1.5 space-y-1 pl-5 first:mt-0 last:mb-0 ${
                b.ordered ? "list-decimal" : "list-disc"
              } marker:text-faint`}
            >
              {b.items.map((item, j) => (
                <li key={`${key}-${j}`} className="pl-0.5">
                  {renderInline(item, `${key}-${j}`)}
                </li>
              ))}
            </ListTag>
          );
        }

        return (
          <p key={key} className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0">
            {renderInline(b.text, key)}
          </p>
        );
      })}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context / denied permission) — ignore */
    }
  }

  return (
    <div className="code-shell my-2 max-w-full">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[0.7rem] uppercase tracking-wide text-slate-400">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-1.5 py-0.5 text-[0.7rem] text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
          aria-label={copied ? "Code copied to clipboard" : "Copy code to clipboard"}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* break-normal + whitespace-pre override the bubble's inherited `break-words`,
          so long lines stay on one line and scroll here instead of wrapping.
          tabIndex makes the scroll container reachable by keyboard. */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={lang ? `${lang} code snippet` : "Code snippet"}
        className="scroll-slim w-full min-w-0 max-w-full overflow-x-auto whitespace-pre break-normal px-3 py-2.5"
      >
        <code className="block font-mono text-[0.78rem] leading-relaxed text-slate-100">
          {code.replace(/\s+$/, "")}
        </code>
      </pre>
    </div>
  );
}

export default function MessageContent({ content }: { content: string }) {
  const segments = parseSegments(content);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "code") {
          // Drop an empty trailing block, e.g. a fence that just opened.
          if (seg.unterminated && seg.code.trim() === "") return null;
          return <CodeBlock key={i} lang={seg.lang} code={seg.code} />;
        }

        const text = cleanProse(seg.text);
        // Collapse whitespace-only gaps between blocks.
        if (text.trim() === "") return null;
        return <Prose key={i} idx={i} text={text.trim()} />;
      })}
    </>
  );
}
