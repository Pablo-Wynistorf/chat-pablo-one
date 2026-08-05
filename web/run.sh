#!/bin/bash
# Lambda handler script, launched by the AWS Lambda Web Adapter (/opt/bootstrap).
# Starts the Next.js standalone server; the adapter proxies API Gateway requests
# to it over HTTP on $PORT.
set -euo pipefail

# Bind to all interfaces (Next standalone honours HOSTNAME); default port 8080
# matches the Lambda Web Adapter's readiness check.
export HOSTNAME=0.0.0.0
export PORT="${PORT:-8080}"

exec node server.js
