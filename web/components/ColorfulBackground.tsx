"use client";

import { useEffect, useState } from "react";
import { useTheme } from "./ThemeProvider";

/** The animated WebGL gradient, embedded rather than reimplemented. */
const GRADIENT_URL = "https://color.onedns.ch/";

/**
 * Full-bleed animated gradient for the "colorful" theme.
 *
 * It's an <iframe> because color.onedns.ch is a self-contained WebGL page
 * (canvas + shaders + its own colour variables). Porting it would mean owning
 * ~600 lines of minified WebGL for no benefit; embedding keeps it a single
 * element. It sets no X-Frame-Options or frame-ancestors, so framing is allowed.
 *
 * `pointer-events: none` is essential — without it the iframe swallows every
 * click and scroll meant for the chat. It's also aria-hidden and not focusable,
 * so assistive tech and keyboard tabbing skip it entirely.
 *
 * Visitors who ask for reduced motion get the static CSS gradient defined in
 * globals.css instead of a continuously animating canvas.
 */
export default function ColorfulBackground() {
  const { theme, ready } = useTheme();
  const [allowMotion, setAllowMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) {
      setAllowMotion(true);
      return;
    }
    const apply = () => setAllowMotion(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  if (!ready || theme !== "colorful" || !allowMotion) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <iframe
        src={GRADIENT_URL}
        title=""
        tabIndex={-1}
        loading="lazy"
        scrolling="no"
        // sandbox with allow-scripts only: the page needs JS for the WebGL canvas
        // but has no business reaching storage, forms, popups or our origin.
        sandbox="allow-scripts"
        className="pointer-events-none h-full w-full border-0"
      />
      {/* Slight darkening so white text stays legible over the yellow band. */}
      <div className="pointer-events-none absolute inset-0 bg-black/25" />
    </div>
  );
}
