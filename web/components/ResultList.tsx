"use client";

import type { PageResult } from "@/lib/types";

interface Props {
  results: PageResult[];
  loading: boolean;
  error: string | null;
  hasSearched: boolean;
}

/** Pretty label for the page URL shown under the title. */
function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export default function ResultList({ results, loading, error, hasSearched }: Props) {
  if (loading) {
    return (
      <ul className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="animate-pulse rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 h-4 w-2/3 rounded bg-slate-200" />
            <div className="mb-3 h-3 w-1/3 rounded bg-slate-100" />
            <div className="h-3 w-full rounded bg-slate-100" />
          </li>
        ))}
      </ul>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
        {error}
      </div>
    );
  }

  if (hasSearched && results.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        No matching pages. Try rephrasing your query.
      </div>
    );
  }

  if (!hasSearched) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white/50 p-6 text-center text-sm text-slate-400">
        Type a natural-language query above to find the page that answers it.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {results.map((r) => (
        <li
          key={r.url}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
        >
          <div className="flex items-start justify-between gap-3">
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-base font-semibold text-sky-700 hover:underline"
            >
              {r.title}
            </a>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              {(r.score * 100).toFixed(0)}% match
            </span>
          </div>

          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block text-xs text-emerald-700 hover:underline"
          >
            {displayUrl(r.url)}
          </a>

          {r.section ? (
            <span className="mt-2 mr-2 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
              {r.section}
            </span>
          ) : null}

          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {r.snippet || r.description}
          </p>
        </li>
      ))}
    </ul>
  );
}
