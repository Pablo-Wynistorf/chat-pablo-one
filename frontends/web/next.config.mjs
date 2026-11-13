import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/**
 * Static export: `next build` writes a plain static site to out/, which TerraForge
 * publishes to S3 as one version behind CloudFront. There is no Next server in
 * production — /api/* is routed by CloudFront to API Gateway and the API Lambda
 * (functions/api).
 *
 * The `Accept-CH` Client Hints opt-in that used to live in headers() here is now
 * added at the edge by the CloudFront response headers policy
 * (terraform/frontend.tf), since S3 cannot send custom headers.
 */
export default function config(phase) {
  /** @type {import('next').NextConfig} */
  const nextConfig = {
    reactStrictMode: true,
    output: "export",
  };

  // Local development only: `next dev` proxies /api/* to the API function's local
  // server (cd functions/api && npm run dev). Rewrites are not part of a static
  // export, so production is unaffected.
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const apiDevUrl = process.env.API_DEV_URL ?? "http://localhost:3001";
    nextConfig.rewrites = async () => [{ source: "/api/:path*", destination: `${apiDevUrl}/api/:path*` }];
  }

  return nextConfig;
}
