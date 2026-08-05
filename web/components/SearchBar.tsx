"use client";

import type { FormEvent } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  loading?: boolean;
}

export default function SearchBar({ value, onChange, onSubmit, loading }: Props) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ask anything about pablo.one…"
        className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base shadow-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300"
      />
      <button
        type="submit"
        disabled={loading || value.trim() === ""}
        className="shrink-0 rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? "Searching…" : "Search"}
      </button>
    </form>
  );
}
