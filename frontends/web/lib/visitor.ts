/**
 * Shape of the visitor picture the greeting API returns in its `x-visitor`
 * header (see functions/api/src/lib/visitor.ts, which builds it).
 *
 * Types only: this frontend is a self-contained static export, so it carries its
 * own copy of the contract instead of importing from the API's folder. Keep the
 * two in sync when the greeting response changes.
 */

export interface VisitorGeo {
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  /** Derived locally from countryCode — never taken from the geo provider. */
  flag?: string;
  timezone?: string;
  isp?: string;
  asn?: string;
}

export interface VisitorContext {
  /** Public IP, possibly masked when VISITOR_HIDE_IP is set. */
  ip?: string;
  ipVersion?: "IPv4" | "IPv6";
  geo?: VisitorGeo;

  /** Best available timezone: browser-reported wins over IP-derived. */
  timezone?: string;
  localTime?: string;
  weekday?: string;
  /** "morning", "afternoon", "evening", "the middle of the night". */
  partOfDay?: string;

  browser?: string;
  engine?: string;
  os?: string;
  device?: "phone" | "tablet" | "desktop";
  deviceModel?: string;
  arch?: string;

  /** Human-readable preferred languages, most-preferred first, for display. */
  languages?: string[];
  /** Most-preferred BCP-47 tag exactly as sent, e.g. "de-CH". */
  languageTag?: string;
  /** Plain language name to write in, e.g. "German". */
  language?: string;
  colorScheme?: "dark" | "light";
  reducedMotion?: boolean;

  screen?: string;
  dpr?: number;
  cores?: number;
  memoryGb?: number;
  connection?: string;
  saveData?: boolean;
  /** CloudFront only: negotiated protocol versions. */
  httpVersion?: string;
  tls?: string;

  referrer?: string;
  /** True when this browser has been here before (localStorage, per-device). */
  returning?: boolean;
  /** How many times this browser has been here (localStorage, per-device). */
  visitCount?: number;
  /** Site-wide unique visitors from count.onedns.ch. Reported by the browser. */
  siteVisitors?: number;
  bot?: boolean;
}
