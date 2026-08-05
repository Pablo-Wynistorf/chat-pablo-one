"use client";

import { THEMES, useTheme, type Theme } from "./ThemeProvider";

const LABELS: Record<Theme, { title: string; icon: JSX.Element }> = {
  light: {
    title: "Light",
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </>
    ),
  },
  dark: {
    title: "Dark",
    icon: <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  },
  colorful: {
    title: "Colorful",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 1 0 18M3.6 9h16.8M3.6 15h16.8" />
      </>
    ),
  },
};

/**
 * Segmented three-way theme switch. A segmented control rather than a cycling
 * button so the available themes — including the non-obvious "colorful" — are
 * discoverable without clicking through them.
 */
export default function ThemeToggle() {
  const { theme, setTheme, ready } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="panel inline-flex items-center gap-0.5 rounded-full p-0.5"
    >
      {THEMES.map((t) => {
        const active = ready && theme === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${LABELS[t].title} theme`}
            title={`${LABELS[t].title} theme`}
            onClick={() => setTheme(t)}
            className={`grid h-7 w-7 place-items-center rounded-full transition ${
              active
                ? "bg-accent text-accent-fg shadow-bubble"
                : "text-muted hover:text-fg"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              {LABELS[t].icon}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
