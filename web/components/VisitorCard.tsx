"use client";

import { useState } from "react";
// Type-only: lib/visitor.ts is server code (env reads, geo fetch) and must not
// be bundled into the client.
import type { VisitorContext } from "@/lib/visitor";

interface Detail {
  label: string;
  value: string;
}

/** Everything worth showing, in the order it reads best. Blanks are dropped. */
function details(v: VisitorContext): Detail[] {
  const g = v.geo;
  const place = [g?.city, g?.region !== g?.city ? g?.region : undefined, g?.country]
    .filter(Boolean)
    .join(", ");

  const rows: (Detail | false)[] = [
    place !== "" && { label: "Location", value: g?.flag ? `${place} ${g.flag}` : place },
    !!v.localTime && {
      label: "Local time",
      value: `${v.localTime}${v.weekday ? `, ${v.weekday}` : ""}`,
    },
    !!v.timezone && { label: "Timezone", value: v.timezone },
    !!v.ip && { label: "IP address", value: `${v.ip}${v.ipVersion ? ` (${v.ipVersion})` : ""}` },
    !!g?.isp && { label: "Network", value: g.asn ? `${g.isp} · ${g.asn}` : g.isp },
    !!v.browser && { label: "Browser", value: v.engine ? `${v.browser} · ${v.engine}` : v.browser },
    !!v.os && { label: "OS", value: v.os },
    !!v.device && {
      label: "Device",
      value: v.deviceModel ? `${v.device} · ${v.deviceModel}` : v.device,
    },
    !!v.arch && { label: "CPU", value: v.cores ? `${v.arch} · ${v.cores} cores` : v.arch },
    !v.arch && !!v.cores && { label: "CPU cores", value: String(v.cores) },
    !!v.memoryGb && { label: "Memory", value: `~${v.memoryGb} GB` },
    !!v.screen && { label: "Screen", value: v.dpr ? `${v.screen} @ ${v.dpr}x` : v.screen },
    !!v.languages?.length && { label: "Languages", value: v.languages.join(", ") },
    !!v.colorScheme && { label: "Theme", value: `prefers ${v.colorScheme}` },
    v.reducedMotion === true && { label: "Motion", value: "prefers reduced" },
    !!v.connection && { label: "Connection", value: v.connection },
    v.saveData === true && { label: "Data saver", value: "on" },
    (!!v.httpVersion || !!v.tls) && {
      label: "Protocol",
      value: [v.httpVersion, v.tls].filter(Boolean).join(" · "),
    },
    !!v.referrer && { label: "Came from", value: v.referrer },
    v.returning === true && {
      label: "Your visits",
      value: `${(v.visitCount ?? 1) + 1} (welcome back)`,
    },
    v.siteVisitors !== undefined && {
      label: "Site visitors",
      value: v.returning
        ? v.siteVisitors.toLocaleString()
        : `you're #${v.siteVisitors.toLocaleString()}`,
    },
  ];

  return rows.filter((r): r is Detail => r !== false);
}

/**
 * The receipts behind a personalised greeting: collapsed to one quiet line by
 * default, expandable into the full list. Showing the working is what turns
 * "how did it know that?" into "oh, that's just my request headers".
 */
export default function VisitorCard({ visitor }: { visitor: VisitorContext }) {
  const [open, setOpen] = useState(false);
  const rows = details(visitor);
  if (rows.length === 0) return null;

  return (
    <div className="pl-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="chip inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted shadow-bubble"
      >
        <span aria-hidden="true">🔎</span>
        <span>{open ? "Hide" : "How did I know that?"}</span>
        <span
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>

      {open ? (
        <div className="panel-sunken mt-2 animate-fade-up rounded-xl p-3">
          <p className="text-xs text-muted">
            All of this came from the request your browser just made — its headers, the
            Client Hints it volunteered, and an IP lookup. None of it is stored;{" "}
            {visitor.siteVisitors !== undefined ? (
              <>the only thing recorded is the visitor tally below.</>
            ) : (
              <>nothing is written down.</>
            )}
          </p>
          <dl className="mt-2.5 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line/40 pb-1 last:border-0 sm:border-0 sm:pb-0"
              >
                <dt className="shrink-0 text-xs text-faint">{r.label}</dt>
                <dd className="min-w-0 truncate text-xs font-medium text-fg" title={r.value}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
