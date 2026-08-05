#!/bin/bash
# Build the Next.js app once and assemble BOTH deployment artifacts:
#
#   .lambda/  — the standalone server, for the API Lambda behind API Gateway.
#               Only /api/* is ever routed here.
#   .static/  — the frontend, for the S3 bucket behind CloudFront: the
#               prerendered document plus the hashed client assets.
#
# One `next build` for both, because building twice doubles a slow step for no
# benefit — the same output directory feeds both artifacts.
#
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WEB_DIR"

echo "==> Installing dependencies (npm ci)"
npm ci

echo "==> Building Next.js (standalone output)"
npm run build

# --- Lambda artifact (API only) ---------------------------------------------

echo "==> Assembling Lambda artifact in .lambda/"
rm -rf .lambda
mkdir -p .lambda

# 1) The self-contained server (server.js + traced node_modules + .next server files)
cp -R .next/standalone/. .lambda/

# 2) Static assets are NOT included in standalone. They are served from S3 now, but
#    keep them in the bundle so hitting the API Gateway URL directly still works —
#    useful for debugging CloudFront without a second deploy.
mkdir -p .lambda/.next
cp -R .next/static .lambda/.next/static

# 3) public/ (favicons, images) if present
if [ -d public ]; then
  cp -R public .lambda/public
fi

# 4) Lambda handler script (must be executable, LF line endings)
cp run.sh .lambda/run.sh
chmod +x .lambda/run.sh

# 5) Strip any .env* files Next copied into the bundle. On Lambda the app must
#    read configuration from the function's environment variables (set by
#    Terraform), NOT a baked-in .env.local — otherwise it would override them
#    (e.g. forcing AWS_ROLE_ARN and assuming the local dev role).
find .lambda -maxdepth 1 -name '.env*' -delete

# --- Static frontend artifact ----------------------------------------------

echo "==> Assembling static frontend in .static/"
rm -rf .static
mkdir -p .static/_next

# The app router prerenders "/" to a plain HTML file because page.tsx is entirely
# client-side ("use client") with no server data fetching. That document only
# references /_next/static/* — verified, no server round-trip needed — so it can be
# served straight from S3 while the client-side fetches go to /api/* via CloudFront.
if [ ! -f .next/server/app/index.html ]; then
  echo "✖ .next/server/app/index.html missing." >&2
  echo "  The root route stopped being statically prerenderable — check for a" >&2
  echo "  server component, cookies()/headers() call, or force-dynamic in app/." >&2
  exit 1
fi

cp .next/server/app/index.html .static/index.html
# CloudFront's custom error response points 404s here.
if [ -f .next/server/app/_not-found.html ]; then
  cp .next/server/app/_not-found.html .static/404.html
fi

cp -R .next/static .static/_next/static

if [ -d public ]; then
  cp -R public/. .static/
fi

echo "==> Done."
echo "    Lambda artifact : $WEB_DIR/.lambda"
echo "    Static frontend : $WEB_DIR/.static ($(find .static -type f | wc -l | tr -d ' ') files)"
