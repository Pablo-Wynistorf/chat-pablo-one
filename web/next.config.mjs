import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Client Hints we ask the browser to volunteer. Chromium sends only the low-entropy
 * set (Sec-CH-UA, -Mobile, -Platform) unless the origin opts in via `Accept-CH`.
 * The document response registers this list, and every later request from the page
 * — including the client-side `/api/greeting` fetch — carries them. That's what
 * turns "Chrome on Windows" into "Chrome 140 on Windows 11, ARM64, dark mode".
 *
 * Firefox and Safari ignore this and are handled by User-Agent parsing instead
 * (see lib/visitor.ts). No `Critical-CH`: that would make the browser re-issue the
 * document request, and the hints land in time for the greeting fetch regardless.
 */
const CLIENT_HINTS = [
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Mobile",
  "Sec-CH-Prefers-Color-Scheme",
  "Sec-CH-Prefers-Reduced-Motion",
  "Device-Memory",
  "DPR",
  "Save-Data",
  "Downlink",
  "RTT",
  "ECT",
].join(", ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Accept-CH", value: CLIENT_HINTS }],
      },
    ];
  },
  // Produce a self-contained server bundle (.next/standalone/server.js) so it
  // can run on AWS Lambda behind the Lambda Web Adapter.
  output: "standalone",
  experimental: {
    // Pin the standalone tracing root to this app dir so server.js lands at the
    // root of .next/standalone (there are sibling lockfiles in the repo).
    outputFileTracingRoot: __dirname,
    // AWS SDK is server-only; keep it out of the client bundle (Next 14 key).
    serverComponentsExternalPackages: [
      "@aws-sdk/client-s3vectors",
      "@aws-sdk/client-bedrock-runtime",
      "@aws-sdk/client-dynamodb",
      "@aws-sdk/credential-providers",
    ],
  },
};

export default nextConfig;
