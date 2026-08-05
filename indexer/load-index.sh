#!/bin/bash
# Embed the committed chunks in data/*.json and load them into the S3 Vectors
# index. Called by Terraform (see terraform/indexer.tf) so a single
# `terraform apply` leaves a populated, queryable index behind.
#
# This deliberately does NOT crawl. Ingest (website, GitHub, code, curated docs)
# needs network access and produces non-deterministic output, so data/*.json is
# committed to the repo and refreshed on purpose with `npm run ingest:all`.
#
# Credentials: whatever Terraform itself is running as. The alternative — assuming
# the least-privilege dev role this same apply just created — adds IAM propagation
# flakiness to a bootstrap that already holds strictly broader rights, for no real
# security gain.
set -euo pipefail

INDEXER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$INDEXER_DIR"

: "${VECTOR_BUCKET:?VECTOR_BUCKET must be set}"
: "${VECTOR_INDEX:?VECTOR_INDEX must be set}"

# Terraform supplies the bucket/index; never let a stale web/.env.local override.
export INDEXER_SKIP_DOTENV=1

if [ ! -d data ] || [ -z "$(ls -A data/*.json 2>/dev/null)" ]; then
  echo "✖ No chunk files in indexer/data/." >&2
  echo "  These are committed to the repo. If you're working from a fresh checkout," >&2
  echo "  generate them once with:  cd indexer && npm ci && npm run ingest:all" >&2
  exit 1
fi

# node_modules is gitignored, so a fresh clone needs an install. tsx is a
# devDependency, so this can't be --omit=dev.
if [ ! -x node_modules/.bin/tsx ]; then
  echo "==> Installing indexer dependencies (npm ci)"
  npm ci
fi

# Incremental: the loader reads the contentHash metadata already stored on the
# vectors in the index and embeds only chunks that are new or edited. Running this
# with nothing changed costs $0.00, so it is safe on every apply.
echo "==> Syncing vectors into ${VECTOR_BUCKET}/${VECTOR_INDEX}"
npm run index
