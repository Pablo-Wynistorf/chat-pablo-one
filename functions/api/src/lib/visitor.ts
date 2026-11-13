/**
 * Everything we can honestly tell about a visitor from ONE request.
 *
 * Three sources, in order of trustworthiness:
 *   1. Request headers the browser sends on its own — User-Agent, Accept-Language,
 *      and the Client Hints we ask for via `Accept-CH` (added by the CloudFront response headers policy, terraform/frontend.tf).
 *   2. An IP → geo lookup (city, country, ISP, timezone). Network call, so it is
 *      cached per IP and hard-capped by a short timeout; failure is non-fatal.
 *   3. A handful of query params the page attaches to its own greeting fetch —
 *      things only the browser knows (real timezone, screen, `document.referrer`,
 *      whether they've been here before).
 *
 * SECURITY: every field here is attacker-controlled and ends up inside a model
 * prompt. Nothing is passed through raw. Strings go through `clean()` (character
 * allow-list + length cap), numbers are parsed and range-checked, the raw
 * User-Agent is never forwarded — only the fields we parsed out of it — and
 * referrers collapse to a known label or a bare hostname. That keeps a crafted
 * header from smuggling instructions into the prompt.
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
  /**
   * Plain language name to write in, e.g. "German".
   *
   * Deliberately the *base* language rather than the regional variant: `languages`
   * holds "Swiss High German" / "American English", which are accurate labels but
   * terrible instructions to hand a model.
   */
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

// --- sanitising -------------------------------------------------------------

/**
 * Letters, digits and a small punctuation set. Deliberately excludes newlines,
 * braces, quotes, backticks and angle brackets — the characters you'd reach for
 * to fake a prompt section or close a JSON string.
 */
const ALLOWED = /[^\p{L}\p{N} .,'&_/+()-]/gu;

function clean(value: string | null | undefined, max = 48): string | undefined {
  if (!value) return undefined;
  const out = value.replace(ALLOWED, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return out === "" ? undefined : out;
}

/**
 * For header values that are a fixed vocabulary (platform, architecture). An
 * unrecognised value is dropped rather than sanitised, so a hand-crafted header
 * can't put its own text in front of the model at all.
 */
function oneOf<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
): T | undefined {
  const v = value?.replace(/"/g, "").trim();
  return allowed.find((a) => a.toLowerCase() === v?.toLowerCase());
}

function num(value: string | null | undefined, min: number, max: number): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n * 100) / 100;
}

// --- IP ---------------------------------------------------------------------

/**
 * First hop in `X-Forwarded-For` is the client as seen by API Gateway. Later
 * entries are proxies, and the whole header is spoofable, so this is only ever
 * used for colour — never for authorisation.
 */
function readIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  const raw =
    (xff ? xff.split(",")[0] : null) ??
    req.headers.get("x-real-ip") ??
    req.headers.get("cf-connecting-ip");
  const ip = raw?.trim();
  if (!ip) return undefined;
  return /^[0-9a-fA-F.:]{3,45}$/.test(ip) ? ip : undefined;
}

/** Loopback, RFC1918, CGNAT, link-local — nothing a geo provider can resolve. */
function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) {
    return true;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Drop the last octet / trailing hextets so logs and prompts hold less. */
function maskIp(ip: string): string {
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::";
  const p = ip.split(".");
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : ip;
}

/** 🇨🇭 from "CH" — regional indicator symbols, no lookup table needed. */
function flagOf(code?: string): string | undefined {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return undefined;
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// --- geo lookup -------------------------------------------------------------

/**
 * Geo straight off whichever CDN is in front — no network call, no rate limit, no
 * third party, no added latency. Always preferred over `lookupGeo`.
 *
 * Supports both edges the app can realistically sit behind:
 *   - CloudFront: needs an origin request policy forwarding `CloudFront-Viewer-*`
 *     (stripped by default).
 *   - Cloudflare: `CF-IPCountry` arrives automatically on proxied traffic; the
 *     city/region/timezone headers need the "Add visitor location headers"
 *     managed transform enabled.
 *
 * Returns undefined when there's no CDN, which is when the IP lookup takes over.
 */
function geoFromEdge(h: Headers): VisitorGeo | undefined {
  return geoFromCloudFront(h) ?? geoFromCloudflare(h);
}

function geoFromCloudFront(h: Headers): VisitorGeo | undefined {
  const countryCode = oneOfCountry(h.get("cloudfront-viewer-country"));
  const city = meaningful(clean(h.get("cloudfront-viewer-city"), 40));
  if (!countryCode && !city) return undefined;

  const asnRaw = h.get("cloudfront-viewer-asn");
  return {
    city,
    region: meaningful(
      clean(
        h.get("cloudfront-viewer-country-region-name") ?? h.get("cloudfront-viewer-country-region"),
        40,
      ),
    ),
    country: clean(h.get("cloudfront-viewer-country-name"), 40) ?? countryName(countryCode),
    countryCode,
    flag: flagOf(countryCode),
    timezone: cleanTimezone(h.get("cloudfront-viewer-time-zone")),
    // The edge gives the ASN but not the operator name.
    asn: /^\d{1,10}$/.test(asnRaw ?? "") ? `AS${asnRaw}` : undefined,
  };
}

function geoFromCloudflare(h: Headers): VisitorGeo | undefined {
  // "XX" = Cloudflare couldn't determine it, "T1" = Tor exit node. oneOfCountry
  // accepts both as valid-looking codes, so reject them explicitly — otherwise
  // flagOf() renders a nonsense flag and countryName() invents a country.
  const raw = h.get("cf-ipcountry")?.trim().toUpperCase();
  const countryCode = raw === "XX" || raw === "T1" ? undefined : oneOfCountry(raw);
  const city = meaningful(clean(h.get("cf-ipcity"), 40));
  if (!countryCode && !city) return undefined;

  return {
    city,
    region: meaningful(clean(h.get("cf-region"), 40)),
    country: countryName(countryCode),
    countryCode,
    flag: flagOf(countryCode),
    timezone: cleanTimezone(h.get("cf-timezone")),
    // Cloudflare exposes no ASN/ISP header, so those stay blank here.
  };
}

/** Two-letter ISO country code, or nothing. */
function oneOfCountry(value: string | null | undefined): string | undefined {
  const v = value?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : undefined;
}

/**
 * Geo providers use filler strings rather than omitting a field they don't know.
 * "Network: Unknown" is worse than saying nothing.
 */
function meaningful(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^(unknown|undefined|null|n\/?a|none|-{1,2}|reserved|private|not set)$/i.test(value.trim())
    ? undefined
    : value;
}

/** "US" -> "United States", so a code-only provider still reads like prose. */
function countryName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return name && name !== code ? clean(name, 40) : undefined;
  } catch {
    return undefined;
  }
}

/** IANA zone ids only — anything else would break Intl and could carry text. */
function cleanTimezone(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v && /^[A-Za-z]+\/[A-Za-z0-9_+\-/]{1,40}$/.test(v) ? v : undefined;
}

/**
 * Fallback when there's no CDN in front. `{ip}` is substituted with the
 * visitor's address; the provider must answer keyless JSON over HTTPS.
 *
 * ipinfo.io is the default because it resolves to city level. The obvious
 * alternative, geojs.io, has no per-day cap but falls back to the ASN's
 * *registration* country when it can't place the host: for the OVH address
 * 51.195.24.96 (a server in Frankfurt) it returned "France" with a Paris
 * centroid, because OVH SAS is a French company. ipinfo returned
 * "Frankfurt am Main, DE". A wrong country is worse than an occasional 429,
 * which just degrades to no geo.
 *
 * The parser below is deliberately tolerant of field naming, so geojs.io,
 * ipwho.is and similar work as drop-in overrides via GEO_API_URL.
 */
const GEO_URL = process.env.GEO_API_URL ?? "https://ipinfo.io/{ip}/json";
const GEO_TIMEOUT_MS = Number.parseInt(process.env.GEO_TIMEOUT_MS ?? "900", 10);
const GEO_TTL_MS = 6 * 60 * 60 * 1000;
const GEO_CACHE_MAX = 500;

const geoCache = new Map<string, { at: number; geo?: VisitorGeo }>();

function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

async function lookupGeo(ip: string): Promise<VisitorGeo | undefined> {
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < GEO_TTL_MS) return hit.geo;

  let geo: VisitorGeo | undefined;
  try {
    const res = await fetch(GEO_URL.replace("{ip}", encodeURIComponent(ip)), {
      cache: "no-store",
      signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      // ipwho.is signals a miss with success:false rather than a 4xx.
      // ipwho.is and friends signal a miss with success:false / error:true in a
      // 200 response rather than a 4xx.
      if (body.success !== false && !body.error) {
        // ipwho.is nests network details; flatter providers put them at the root.
        const conn = (body.connection ?? {}) as Record<string, unknown>;
        // `timezone` is a plain id on most providers, an object on ipwho.is.
        const tz = body.timezone;
        const tzId =
          typeof tz === "string" ? tz : pick((tz ?? {}) as Record<string, unknown>, "id", "name");

        // `country` is a full name on some providers and a 2-letter code on
        // others (ipinfo.io returns "US"), so classify by shape, not by key.
        const countryRaw = pick(body, "country", "country_name");
        const codeFromCountry = oneOfCountry(countryRaw);
        const countryCode =
          oneOfCountry(pick(body, "country_code", "countryCode")) ?? codeFromCountry;

        // "AS15169 Google LLC" carries both the ASN and the operator.
        const orgRaw =
          pick(conn, "isp", "org", "organization", "organization_name") ??
          pick(body, "organization_name", "org", "isp", "organization");
        const orgMatch = /^AS(\d{1,10})\s+(.*)$/i.exec(orgRaw ?? "");
        const asnRaw = pick(conn, "asn") ?? pick(body, "asn");

        geo = {
          city: meaningful(clean(pick(body, "city"), 40)),
          region: meaningful(clean(pick(body, "region", "region_name", "state"), 40)),
          country: codeFromCountry
            ? countryName(countryCode)
            : (meaningful(clean(countryRaw, 40)) ?? countryName(countryCode)),
          countryCode,
          flag: flagOf(countryCode),
          timezone: cleanTimezone(tzId),
          isp: meaningful(clean(orgMatch ? orgMatch[2] : orgRaw, 40)),
          asn: /^\d{1,10}$/.test(asnRaw ?? "")
            ? `AS${asnRaw}`
            : orgMatch
              ? `AS${orgMatch[1]}`
              : clean(asnRaw, 12),
        };
        // A provider can answer 200 and still tell us nothing usable.
        if (!Object.values(geo).some(Boolean)) geo = undefined;
      }
    }
  } catch {
    // Timeout, DNS, rate limit — the greeting works fine without geo.
    geo = undefined;
  }

  if (geoCache.size >= GEO_CACHE_MAX) {
    const oldest = geoCache.keys().next().value;
    if (oldest !== undefined) geoCache.delete(oldest);
  }
  geoCache.set(ip, { at: Date.now(), geo });
  return geo;
}

// --- clock ------------------------------------------------------------------

function localClock(tz?: string): Pick<VisitorContext, "localTime" | "weekday" | "partOfDay"> {
  if (!tz) return {};
  try {
    const now = new Date();
    const localTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    const weekday = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
    }).format(now);

    const hour = Number.parseInt(localTime.slice(0, 2), 10);
    const partOfDay =
      hour < 5
        ? "the middle of the night"
        : hour < 12
          ? "morning"
          : hour < 17
            ? "afternoon"
            : hour < 22
              ? "evening"
              : "late evening";

    return { localTime, weekday, partOfDay };
  } catch {
    // An invalid IANA id throws rather than falling back.
    return {};
  }
}

// --- user agent -------------------------------------------------------------

const BOT_RE =
  /(bot|crawl|spider|slurp|bingpreview|headless|lighthouse|curl|wget|python-requests|axios|okhttp|postman|monitor|preview)/i;

/** The values Chromium is specified to send for these enumerated hints. */
const PLATFORMS = [
  "Android",
  "Chrome OS",
  "Chromium OS",
  "iOS",
  "Linux",
  "macOS",
  "Windows",
  "Unknown",
] as const;
const ARCHITECTURES = ["x86", "arm", "arm64", "loongarch64", "unknown"] as const;

/** `"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"` → brand + major. */
function fromBrandList(list: string | null): { name: string; version: string } | undefined {
  if (!list) return undefined;
  const entries = [...list.matchAll(/"([^"]+)";\s*v="([^"]+)"/g)].map((m) => ({
    name: m[1]!,
    version: m[2]!,
  }));
  // GREASE padding brands exist specifically to break naive parsers, and the
  // punctuation between the words is deliberately random per release —
  // "Not=A?Brand", "Not-A.Brand", "Not/A)Brand", " Not;A Brand". Matching on
  // punctuation is a losing game, so compare on letters alone. Chromium is the
  // engine every derivative reports, not the product the visitor chose.
  const isGrease = (name: string) => /^nota?brand$/i.test(name.replace(/[^a-z]/gi, ""));
  const real = entries.find((e) => !isGrease(e.name) && e.name !== "Chromium");
  const chosen = real ?? entries.find((e) => e.name === "Chromium");
  if (!chosen) return undefined;
  return { name: chosen.name, version: chosen.version.split(".")[0]! };
}

function parseUa(req: Request): Pick<
  VisitorContext,
  "browser" | "engine" | "os" | "device" | "deviceModel" | "arch" | "bot"
> {
  const h = req.headers;
  const ua = h.get("user-agent") ?? "";
  const bot = BOT_RE.test(ua) || ua === "";

  // --- browser: Client Hints first, they're structured and honest ----------
  let browser: string | undefined;
  const brand =
    fromBrandList(h.get("sec-ch-ua-full-version-list")) ?? fromBrandList(h.get("sec-ch-ua"));
  if (brand) {
    browser = clean(`${brand.name} ${brand.version}`, 40);
  } else {
    // Order matters: Edge and Opera both also claim "Chrome", and everything
    // claims "Safari".
    const m =
      /\b(Edg|EdgA|EdgiOS)\/(\d+)/.exec(ua) ??
      /\b(OPR|Opera)\/(\d+)/.exec(ua) ??
      /\b(SamsungBrowser)\/(\d+)/.exec(ua) ??
      /\b(Vivaldi|Brave|DuckDuckGo|YaBrowser)\/(\d+)/.exec(ua) ??
      /\b(FxiOS|Firefox)\/(\d+)/.exec(ua) ??
      /\b(CriOS|Chrome)\/(\d+)/.exec(ua) ??
      /\bVersion\/(\d+).*\b(Safari)\//.exec(ua);
    if (m) {
      const names: Record<string, string> = {
        Edg: "Edge",
        EdgA: "Edge",
        EdgiOS: "Edge",
        OPR: "Opera",
        CriOS: "Chrome",
        FxiOS: "Firefox",
        SamsungBrowser: "Samsung Internet",
        YaBrowser: "Yandex Browser",
      };
      // The Safari branch captures (version, name); every other branch is (name, version).
      const isSafari = m[2] === "Safari";
      const rawName = isSafari ? "Safari" : m[1]!;
      const version = isSafari ? m[1]! : m[2]!;
      browser = clean(`${names[rawName] ?? rawName} ${version}`, 40);
    }
  }

  const engine = /\bGecko\/|Firefox\//.test(ua)
    ? "Gecko"
    : /\bAppleWebKit\//.test(ua) && !/\bChrom(e|ium)\//.test(ua) && !brand
      ? "WebKit"
      : /\bAppleWebKit\/|Chrom(e|ium)\//.test(ua) || brand
        ? "Blink"
        : undefined;

  // --- os ------------------------------------------------------------------
  // Platform is an enumerated hint, so an unknown value means a forged header —
  // fall through to User-Agent parsing rather than echoing it back.
  const hintPlatform = oneOf(h.get("sec-ch-ua-platform"), PLATFORMS);
  const hintPlatformVersion = /^[\d.]{1,16}$/.test(
    h.get("sec-ch-ua-platform-version")?.replace(/"/g, "") ?? "",
  )
    ? h.get("sec-ch-ua-platform-version")!.replace(/"/g, "")
    : undefined;
  let os: string | undefined;
  if (hintPlatform && hintPlatform !== "Unknown") {
    const major = Number.parseInt(hintPlatformVersion ?? "", 10);
    if (hintPlatform === "Windows" && Number.isFinite(major)) {
      // Windows 10 and 11 both report NT 10.0; only the CH platform-version
      // distinguishes them (>= 13 means 11).
      os = major >= 13 ? "Windows 11" : major >= 1 ? "Windows 10" : "Windows";
    } else if (hintPlatformVersion && Number.isFinite(major) && major > 0) {
      os = `${hintPlatform} ${major}`;
    } else {
      os = hintPlatform;
    }
  } else if (/iPhone|iPad|iPod/.test(ua)) {
    const v = /OS (\d+)[._]/.exec(ua)?.[1];
    os = v ? `iOS ${v}` : "iOS";
  } else if (/Android/.test(ua)) {
    const v = /Android (\d+)/.exec(ua)?.[1];
    os = v ? `Android ${v}` : "Android";
  } else if (/Mac OS X/.test(ua)) {
    const v = /Mac OS X (\d+)[._](\d+)/.exec(ua);
    // Safari freezes this at 10_15_7, so a 10.x reading tells us nothing precise.
    os = v && v[1] !== "10" ? `macOS ${v[1]}` : "macOS";
  } else if (/CrOS/.test(ua)) {
    os = "ChromeOS";
  } else if (/Windows NT/.test(ua)) {
    os = "Windows";
  } else if (/Linux/.test(ua)) {
    os = "Linux";
  }

  // --- device --------------------------------------------------------------
  const mobileHint = h.get("sec-ch-ua-mobile");
  const deviceModel = clean(h.get("sec-ch-ua-model")?.replace(/"/g, ""), 32);
  const device: VisitorContext["device"] = /iPad|Tablet/.test(ua)
    ? "tablet"
    : mobileHint === "?1" || /Mobile|iPhone|Android.*Mobile/.test(ua)
      ? "phone"
      : "desktop";

  const archHint = oneOf(h.get("sec-ch-ua-arch"), ARCHITECTURES);
  const bitness = oneOf(h.get("sec-ch-ua-bitness"), ["32", "64"] as const);
  // "arm" + "64" reads better joined ("ARM64"); "x86" keeps the hyphen ("x86-64").
  const arch =
    archHint && archHint !== "unknown"
      ? archHint === "arm"
        ? `ARM${bitness ?? ""}`
        : `${archHint}${bitness ? `-${bitness}` : ""}`
      : undefined;

  return { browser, engine, os, device, deviceModel, arch, bot };
}

// --- language ---------------------------------------------------------------

const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * Ordered BCP-47 tags, most preferred first.
 *
 * Accept-Language carries q-weights, but browsers already emit the list in
 * descending preference, so document order is enough — and `navigator.language`
 * (the `fallback`) is the more reliable signal, so it goes first.
 */
function languageTags(header: string | null, fallback?: string): string[] {
  const tags = (header ?? "")
    .split(",")
    .map((part) => part.split(";")[0]!.trim())
    .filter((t) => t !== "*" && LANG_TAG.test(t));
  if (fallback && LANG_TAG.test(fallback)) tags.unshift(fallback);

  const seen = new Set<string>();
  return tags.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayNames(): Intl.DisplayNames | undefined {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    return undefined;
  }
}

/**
 * The language to actually write in: "de-CH" -> "German", "en-US" -> "English".
 *
 * A script subtag is kept because it changes the written form ("zh-Hant" ->
 * "Traditional Chinese"); a region subtag is dropped because it doesn't.
 */
function writtenLanguage(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const parts = tag.split("-");
  const base = parts[0]!.toLowerCase();
  const script = parts.slice(1).find((p) => /^[A-Za-z]{4}$/.test(p));
  const lookup = script ? `${base}-${script}` : base;

  const name = displayNames()?.of(lookup);
  // DisplayNames echoes the input back when it doesn't recognise it.
  if (!name || name.toLowerCase() === lookup.toLowerCase()) return undefined;
  return clean(name, 40);
}

function languageNames(tags: string[]): string[] | undefined {
  const display = displayNames();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const name = clean(display?.of(tag) ?? tag, 40) ?? tag;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length === 3) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Language preference from headers alone — no IP lookup, no query params.
 *
 * Used by /api/chat, which needs a language hint on every message but must not
 * pay for the geo lookup that `readVisitor` performs.
 */
export function readLanguage(req: Request): { tag: string; name: string } | undefined {
  // `?lang=` is navigator.language, forwarded by the page. It must win over
  // Accept-Language: those two routinely disagree — a browser whose UI language is
  // English still sends "de-CH,de;q=0.9,en;q=0.8" when the OS region is Swiss. The
  // greeting already prefers navigator.language, so reading only the header here
  // made /api/chat pick a different language than the greeting had used.
  let fromQuery: string | undefined;
  try {
    fromQuery = clean(new URL(req.url).searchParams.get("lang"), 20);
  } catch {
    fromQuery = undefined;
  }

  const tag = languageTags(req.headers.get("accept-language"), fromQuery)[0];
  const name = writtenLanguage(tag);
  return tag && name ? { tag, name } : undefined;
}

// --- referrer ---------------------------------------------------------------

const REFERRERS: [RegExp, string][] = [
  [/(^|\.)google\./, "a Google search"],
  [/(^|\.)bing\.com$/, "a Bing search"],
  [/(^|\.)duckduckgo\.com$/, "a DuckDuckGo search"],
  [/(^|\.)ecosia\.org$/, "an Ecosia search"],
  [/(^|\.)(yandex|baidu)\./, "a search engine"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
  [/(^|\.)github\.(com|io)$/, "GitHub"],
  [/(^|\.)(x|twitter)\.com$|^t\.co$/, "X"],
  [/(^|\.)reddit\.com$/, "Reddit"],
  [/(^|\.)news\.ycombinator\.com$/, "Hacker News"],
  [/(^|\.)(facebook|instagram|threads)\.(com|net)$/, "social media"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
  [/(^|\.)(medium|dev)\.(com|to)$/, "a blog post"],
  [/(^|\.)(mail\.google|outlook|office)\./, "an email link"],
  [/(^|\.)pablo\.one$/, "my own site"],
];

/**
 * Hostnames that are this app's own plumbing rather than somewhere a visitor came
 * from. Without this an API Gateway or CloudFront hostname reads as a referrer,
 * and the model helpfully paraphrases "…execute-api.eu-central-1.amazonaws.com"
 * as "you popped in through Amazon" — which is nonsense.
 */
const INFRA_HOST_RE =
  /(^|\.)(execute-api\.[a-z0-9-]+\.amazonaws\.com|lambda-url\.[a-z0-9-]+\.on\.aws|cloudfront\.net|elb\.amazonaws\.com|amazonaws\.com|awsapprunner\.com|vercel\.app|netlify\.app)$/;

function parseReferrer(
  raw: string | null | undefined,
  selfHosts: (string | undefined)[],
): string | undefined {
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  if (!host) return undefined;

  // Same-origin navigation (a reload, or a link within the app) is not a referrer.
  const selves = new Set(
    selfHosts.filter((h): h is string => !!h).map((h) => h.toLowerCase().replace(/^www\./, "")),
  );
  if (selves.has(host)) return undefined;

  if (INFRA_HOST_RE.test(host)) return undefined;

  for (const [re, label] of REFERRERS) if (re.test(host)) return label;
  return clean(host, 40);
}

// --- connection -------------------------------------------------------------

function parseConnection(req: Request): { connection?: string; saveData?: boolean } {
  const h = req.headers;
  const ect = clean(h.get("ect"), 8);
  const rtt = num(h.get("rtt"), 0, 10_000);
  const downlink = num(h.get("downlink"), 0, 1000);

  const bits: string[] = [];
  if (ect) bits.push(ect.toUpperCase());
  if (downlink !== undefined) bits.push(`~${downlink} Mbps`);
  if (rtt !== undefined) bits.push(`${Math.round(rtt)} ms RTT`);

  return {
    connection: bits.length > 0 ? bits.join(", ") : undefined,
    saveData: h.get("save-data") === "on" ? true : undefined,
  };
}

// --- assembly ---------------------------------------------------------------

const HIDE_IP = process.env.VISITOR_HIDE_IP === "true";

/**
 * Build the visitor picture for a request. Awaits at most one network call (the
 * geo lookup) and never throws — a missing field just means one less detail for
 * the greeting to play with.
 */
export async function readVisitor(req: Request): Promise<VisitorContext> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const h = req.headers;

  const ip = readIp(req);
  // Edge geo is instant and free, so only pay for a network lookup when there's
  // no CloudFront distribution forwarding the viewer headers.
  const geo = geoFromEdge(h) ?? (ip && !isPrivateIp(ip) ? await lookupGeo(ip) : undefined);

  // The browser's own timezone beats the IP's: VPNs, corporate egress and
  // travellers all make the geo guess wrong, and a wrong "good morning" is
  // worse than none.
  const timezone = cleanTimezone(q.get("tz")) ?? geo?.timezone;

  // Only present behind CloudFront. "TLSv1.3:TLS_AES_128_GCM_SHA256:sessionResumed"
  // — the protocol is the interesting part.
  const httpVersion = /^[\d.]{1,5}$/.test(h.get("cloudfront-viewer-http-version") ?? "")
    ? `HTTP/${h.get("cloudfront-viewer-http-version")!.replace(/\.0$/, "")}`
    : undefined;
  const tls = /^TLSv[\d.]{1,4}$/.test(h.get("cloudfront-viewer-tls")?.split(":")[0] ?? "")
    ? h.get("cloudfront-viewer-tls")!.split(":")[0]
    : undefined;

  // navigator.language first (more reliable than the Accept-Language list).
  const langTags = languageTags(h.get("accept-language"), clean(q.get("lang"), 20));

  const visitCount = num(q.get("visits"), 0, 10_000);
  const width = num(q.get("sw"), 100, 20_000);
  const height = num(q.get("sh"), 100, 20_000);

  const prefersDarkHeader = h.get("sec-ch-prefers-color-scheme");
  const darkParam = q.get("dark");
  const colorScheme =
    prefersDarkHeader === "dark" || darkParam === "1"
      ? "dark"
      : prefersDarkHeader === "light" || darkParam === "0"
        ? "light"
        : undefined;

  return {
    ip: ip ? (HIDE_IP ? maskIp(ip) : ip) : undefined,
    ipVersion: ip ? (ip.includes(":") ? "IPv6" : "IPv4") : undefined,
    geo,
    timezone,
    ...localClock(timezone),
    ...parseUa(req),
    languages: languageNames(langTags),
    languageTag: langTags[0],
    language: writtenLanguage(langTags[0]),
    colorScheme,
    reducedMotion:
      h.get("sec-ch-prefers-reduced-motion") === "reduce" || q.get("rm") === "1"
        ? true
        : undefined,
    screen: width && height ? `${Math.round(width)}x${Math.round(height)}` : undefined,
    dpr: num(q.get("dpr") ?? h.get("dpr"), 0.5, 6),
    cores: num(q.get("cores"), 1, 256),
    memoryGb: num(q.get("mem") ?? h.get("device-memory"), 0.25, 128),
    ...parseConnection(req),
    httpVersion,
    tls,
    // ONLY `document.referrer`, forwarded by the page as ?ref=.
    //
    // The `Referer` header is deliberately not used as a fallback: this endpoint is
    // fetched same-origin, so that header is *always* this app's own page. Treating
    // it as a referrer produced a confident "you came in through Amazon" from the
    // API Gateway hostname.
    //
    // Self-host comes from the forwarded headers first, not `req.url` — behind a
    // proxy `req.url` can carry an internal hostname, so comparing against it
    // alone never matches the public hostname.
    referrer: parseReferrer(q.get("ref"), [
      h.get("x-forwarded-host") ?? undefined,
      h.get("host") ?? undefined,
      url.hostname,
    ]),
    returning: visitCount !== undefined && visitCount > 0 ? true : undefined,
    visitCount,
    // Site-wide total from count.onedns.ch, measured in the browser and passed
    // through here. Client-supplied like everything else, so it is bounded and
    // only ever used as a talking point — nothing depends on it.
    siteVisitors: num(q.get("total"), 1, 1_000_000_000),
  };
}

/**
 * Human-readable "where are you" line, e.g. "Zürich, Switzerland 🇨🇭".
 * Used by both the model prompt and the static fallback greeting.
 */
export function describePlace(v: VisitorContext): string | undefined {
  const g = v.geo;
  if (!g) return undefined;
  const place = [g.city, g.country ?? g.countryCode].filter(Boolean).join(", ");
  if (place === "") return undefined;
  return g.flag ? `${place} ${g.flag}` : place;
}

/**
 * Flatten the context into labelled fact lines for the greeting prompt.
 * Only present fields appear, so the model can never reference a blank.
 */
export function visitorFacts(v: VisitorContext): string[] {
  const facts: string[] = [];
  const place = describePlace(v);

  // Phrased as "browsing from" rather than "where they are": the looser wording
  // led the model to odd readings like "glad you're back from Montreal".
  //
  // City-level geo is worth stating; country-only is the signature of a provider
  // that couldn't place the host and fell back to the ASN's registration country,
  // so it gets marked unreliable instead of becoming a confident "you're in France".
  if (place && v.geo?.city) {
    facts.push(`They are browsing from (approximate): ${place}`);
  } else if (place) {
    facts.push(
      `Their country looks like ${place}, but this is a rough IP guess with no city ` +
        `— do NOT state it as fact, and prefer skipping it over guessing wrong`,
    );
  }
  if (v.geo?.region && v.geo.region !== v.geo.city) facts.push(`Region: ${v.geo.region}`);
  if (v.localTime && v.partOfDay) {
    facts.push(
      `Their local time: ${v.localTime} on ${v.weekday ?? "today"} (it is ${v.partOfDay} for them)`,
    );
  }
  if (v.geo?.isp) facts.push(`Network they're on: ${v.geo.isp}${v.geo.asn ? ` (${v.geo.asn})` : ""}`);
  if (v.ip) facts.push(`Their IP address: ${v.ip} (${v.ipVersion})`);
  if (v.browser) facts.push(`Browser: ${v.browser}`);
  if (v.os) facts.push(`Operating system: ${v.os}`);
  if (v.device) facts.push(`Device type: ${v.device}${v.deviceModel ? ` (${v.deviceModel})` : ""}`);
  if (v.arch) facts.push(`CPU architecture: ${v.arch}`);
  if (v.screen) facts.push(`Screen: ${v.screen}${v.dpr ? ` at ${v.dpr}x` : ""}`);
  if (v.cores) facts.push(`CPU cores: ${v.cores}`);
  if (v.memoryGb) facts.push(`Device memory: ~${v.memoryGb} GB`);
  if (v.languages?.length) facts.push(`Preferred language(s): ${v.languages.join(", ")}`);
  if (v.colorScheme) facts.push(`They prefer ${v.colorScheme} mode`);
  if (v.connection) facts.push(`Connection quality: ${v.connection}`);
  if (v.httpVersion || v.tls) {
    facts.push(`They connected over ${[v.httpVersion, v.tls].filter(Boolean).join(" and ")}`);
  }
  if (v.saveData) facts.push("They have data-saver switched on, so keep it brief");
  if (v.referrer) facts.push(`They arrived from: ${v.referrer}`);
  if (v.returning) {
    facts.push(
      `They have been here before (visit number ${(v.visitCount ?? 1) + 1}) — greet them as a returning visitor`,
    );
  }
  if (v.siteVisitors !== undefined) {
    // The counter tracks UNIQUE visitors, so a first-timer has just become the
    // newest one and can be told their number. A returning visitor did not move
    // the total, so only the total itself is true for them.
    facts.push(
      v.returning
        ? `This site has had ${v.siteVisitors.toLocaleString("en-US")} unique visitors so far`
        : `They are unique visitor number ${v.siteVisitors.toLocaleString("en-US")} to this site`,
    );
  }
  return facts;
}

/**
 * Canned greetings for the model-free fallback path.
 *
 * Keyed by base language subtag. The greeting is supposed to be in the visitor's
 * language, and this path has no model to translate with — so the languages most
 * likely here are covered by hand: the four Swiss national languages plus English
 * and Spanish. Anything else falls back to English.
 *
 * `{where}` is substituted with " in <city>" or removed entirely.
 */
const FALLBACK_GREETINGS: Record<
  string,
  { morning: string; afternoon: string; evening: string; night: string; body: string }
> = {
  en: {
    morning: "Good morning",
    afternoon: "Good afternoon",
    evening: "Good evening",
    night: "Up late",
    body: "I'm Pablo 👋 Ask me anything about my work, projects or certifications.",
  },
  de: {
    morning: "Guten Morgen",
    afternoon: "Guten Tag",
    evening: "Guten Abend",
    night: "Noch wach",
    body: "Ich bin Pablo 👋 Frag mich alles über meine Arbeit, Projekte oder Zertifizierungen.",
  },
  fr: {
    morning: "Bonjour",
    afternoon: "Bonjour",
    evening: "Bonsoir",
    night: "Encore debout",
    body: "Je suis Pablo 👋 Demandez-moi ce que vous voulez sur mon travail, mes projets ou mes certifications.",
  },
  it: {
    morning: "Buongiorno",
    afternoon: "Buon pomeriggio",
    evening: "Buonasera",
    night: "Ancora sveglio",
    body: "Sono Pablo 👋 Chiedimi quello che vuoi sul mio lavoro, i miei progetti o le mie certificazioni.",
  },
  rm: {
    morning: "Bun di",
    afternoon: "Bun di",
    evening: "Buna saira",
    night: "Anc adisch",
    body: "Jau sun Pablo 👋 Dumonda mai davart mia lavur, mes projects u mes certificats.",
  },
  es: {
    morning: "Buenos días",
    afternoon: "Buenas tardes",
    evening: "Buenas noches",
    night: "Trasnochando",
    body: "Soy Pablo 👋 Pregúntame lo que quieras sobre mi trabajo, mis proyectos o mis certificaciones.",
  },
};

/**
 * Deterministic greeting for when the model isn't available (daily budget spent,
 * or a Bedrock error). Still personalised — it just can't improvise.
 */
export function fallbackGreeting(v: VisitorContext): string {
  const base = v.languageTag?.split("-")[0]?.toLowerCase() ?? "en";
  const t = FALLBACK_GREETINGS[base] ?? FALLBACK_GREETINGS.en!;

  const opener =
    v.partOfDay === "morning"
      ? t.morning
      : v.partOfDay === "afternoon"
        ? t.afternoon
        : v.partOfDay === "evening" || v.partOfDay === "late evening"
          ? t.evening
          : v.partOfDay === "the middle of the night"
            ? t.night
            : t.morning;

  // Only name the place when we have a city. "over in United States" reads badly,
  // and a country on its own isn't a personal enough detail to be worth it.
  const where = v.geo?.city ? ` – ${describePlace(v)}` : "";

  return `${opener}${where}! ${t.body}`;
}
