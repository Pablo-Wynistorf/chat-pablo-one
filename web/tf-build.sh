#!/bin/bash
# Terraform-facing wrapper around build.sh.
#
# Invoked as a `data "external"` program (see terraform/build.tf), which means:
#   - stdin  receives a JSON object of query values
#   - stdout must contain ONLY a flat JSON object of strings
#   - therefore every human-readable line from the build goes to stderr, which
#     Terraform surfaces if the build fails
#
# Why a data source rather than a provisioner: `aws_s3_object` resolves its
# for_each at plan time, so the artifact has to exist before planning. A
# local-exec provisioner runs during apply — too late for the upload module to
# enumerate on a fresh clone. Data sources read during plan, so this ordering
# works and a single `terraform apply` deploys from nothing.
#
# Consequence: this runs on every plan. It is therefore idempotent and cheap —
# a stamp file of the input hashes short-circuits an unchanged build.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WEB_DIR"

# Consume (and ignore) the query JSON so the pipe never blocks.
cat >/dev/null || true

STAMP=".build-stamp"

# Fingerprint everything that can change the output. Sorted for stability.
current_hash() {
  {
    cat package-lock.json package.json next.config.mjs tailwind.config.ts postcss.config.mjs
    find app components lib -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
      -print0 | sort -z | xargs -0 cat
    cat build.sh
  } | shasum -a 256 | cut -d' ' -f1
}

HASH="$(current_hash)"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HASH" ] && [ -d .static ] && [ -d .lambda ]; then
  echo "==> Build up to date (${HASH:0:12}), skipping" >&2
else
  echo "==> Sources changed (${HASH:0:12}), building" >&2
  # All build chatter to stderr: stdout is reserved for the JSON result.
  bash ./build.sh 1>&2
  printf '%s' "$HASH" > "$STAMP"
fi

STATIC_FILES="$(find .static -type f | wc -l | tr -d ' ')"

# data.external requires every value to be a string.
printf '{"build_hash":"%s","static_dir":"%s","lambda_dir":"%s","static_files":"%s"}\n' \
  "$HASH" "$WEB_DIR/.static" "$WEB_DIR/.lambda" "$STATIC_FILES"
