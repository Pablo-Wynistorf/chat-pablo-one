import type { Metadata } from "next";
import type { ReactNode } from "react";
import ColorfulBackground from "@/components/ColorfulBackground";
import { ThemeProvider, THEME_STORAGE_KEY } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chat with Pablo",
  description:
    "Chat with an AI version of Pablo Wynistorf that answers in the first person, grounded in pablo.one, GitHub, and LinkedIn via Amazon S3 Vectors + Bedrock.",
};

/**
 * Applies the saved theme before first paint.
 *
 * React can't do this: the provider only runs after hydration, so the page would
 * render in light mode and then snap to dark — a white flash on every load. This
 * has to be a blocking inline script in <head>. Kept deliberately tiny, and it
 * falls back to the OS preference when nothing is stored.
 */
const THEME_INIT = `
(function(){
  try {
    var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (t !== "light" && t !== "dark" && t !== "colorful") {
      t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.dataset.theme = t;
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ThemeProvider>
          <ColorfulBackground />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
