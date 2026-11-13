"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const THEMES = ["light", "dark", "colorful"] as const;
export type Theme = (typeof THEMES)[number];

/** Kept in sync with the pre-paint script in app/layout.tsx. */
export const THEME_STORAGE_KEY = "pablo.one.theme";

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** What the OS asks for, used when the visitor has never chosen explicitly. */
function systemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | undefined {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : undefined;
  } catch {
    return undefined; // private mode / storage disabled
  }
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** False until the client has read the stored preference (SSR renders "light"). */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Must match the server-rendered markup on the first pass or React warns about
  // a hydration mismatch; the real value is picked up in the effect below. The
  // inline script in layout.tsx has already set the attribute, so there's no flash.
  const [theme, setThemeState] = useState<Theme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setThemeState(storedTheme() ?? systemTheme());
    setReady(true);
  }, []);

  // Follow the OS while the visitor hasn't picked a theme themselves.
  useEffect(() => {
    if (!ready) return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;

    const onChange = () => {
      if (storedTheme() === undefined) setThemeState(systemTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.theme = theme;
  }, [theme, ready]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage disabled — theme still applies for this page view */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme, ready }), [theme, setTheme, ready]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
