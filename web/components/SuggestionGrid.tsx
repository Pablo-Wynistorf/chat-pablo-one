"use client";

import type { JSX } from "react";

export interface Suggestion {
  /** The question actually sent to the chat. */
  question: string;
  /** Short label shown on the card. */
  label: string;
  /** One-line hint so the card says what you'd get, not just what to click. */
  hint: string;
  icon: JSX.Element;
}

/**
 * Starter questions as a card grid rather than a pill row.
 *
 * The pill row left most of the viewport empty on a desktop screen, and gave no
 * indication of what any question would return. Cards fill the space the
 * transcript isn't using yet and carry a hint each, so the grid does the job of
 * an empty state instead of just being a list of links.
 */
export const SUGGESTIONS: Suggestion[] = [
  {
    question: "Who are you?",
    label: "Who are you?",
    hint: "The short version, in my own words",
    icon: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
      </>
    ),
  },
  {
    question: "What AWS certifications do you have?",
    label: "My certifications",
    hint: "AWS Solutions Architect, Associate and Professional",
    icon: (
      <>
        <circle cx="12" cy="9" r="5" />
        <path d="M9 13.5 8 21l4-2 4 2-1-7.5" />
      </>
    ),
  },
  {
    question: "Tell me about your WorldSkills experience",
    label: "WorldSkills Lyon 2024",
    hint: "Competing for Switzerland in Cloud Computing",
    icon: (
      <>
        <path d="M6 4h12v4a6 6 0 0 1-12 0z" />
        <path d="M12 14v4m-4 2h8M4 5h2m12 0h2" />
      </>
    ),
  },
  {
    question: "What festival projects have you worked on?",
    label: "Event networks",
    hint: "Openair Frauenfeld and UEFA finals",
    icon: (
      <>
        <path d="M4 20V9l8-5 8 5v11" />
        <path d="M9 20v-6h6v6" />
      </>
    ),
  },
  {
    question: "How does this chat actually work?",
    label: "How this chat works",
    hint: "S3 Vectors, Bedrock and the retrieval path",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
        <path d="M7 7h.01M7 17h.01" />
      </>
    ),
  },
  {
    question: "What does it cost you to run this?",
    label: "What it costs to run",
    hint: "The monthly AWS bill, honestly",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M14.5 9.5c-.6-.9-1.5-1.3-2.5-1.3-1.4 0-2.3.8-2.3 1.8 0 1.1 1 1.6 2.4 1.9 1.5.3 2.6.8 2.6 2s-1 1.9-2.5 1.9c-1.1 0-2.1-.5-2.7-1.4" />
        <path d="M12 6.5v11" />
      </>
    ),
  },
];

interface Props {
  onPick: (question: string) => void;
  disabled?: boolean;
}

export default function SuggestionGrid({ onPick, disabled }: Props) {
  return (
    <div className="animate-fade-up">
      <p className="mb-2 pl-0.5 text-[0.7rem] font-medium uppercase tracking-wide text-faint">
        Not sure where to start?
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.question}
            type="button"
            onClick={() => onPick(s.question)}
            disabled={disabled}
            className="panel group flex items-start gap-3 rounded-xl px-3 py-2.5 text-left shadow-bubble transition hover:border-accent/50 disabled:opacity-40"
          >
            <span
              aria-hidden="true"
              className="tile mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted transition group-hover:text-accent"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                {s.icon}
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">{s.label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
