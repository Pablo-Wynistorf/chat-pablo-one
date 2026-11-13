# Builds the web app as part of `terraform apply`, producing both artifacts:
#
#   web/.static/  -> uploaded to S3 object-by-object, served through CloudFront
#   web/.lambda/  -> zipped by data.archive_file, deployed as the API Lambda
#
# Everything lives here: there are no shell scripts in the repo. npm dependencies
# are installed by this step too (`npm ci`), so a clean checkout needs nothing but
# Node, npm and Terraform.
#
# WHY A DATA SOURCE, NOT A PROVISIONER
# `aws_s3_object.for_each` and `data.archive_file` are both resolved during PLAN,
# so the artifacts must exist by then. A `local-exec` provisioner runs during
# apply — too late; on a fresh clone the upload module would enumerate an empty
# directory and deploy nothing. Data sources read at plan time, so one
# `terraform apply` works from a clean checkout.
#
# WHY THE SKIP LOGIC LIVES IN THE SCRIPT, NOT IN HCL
# An earlier version gated the build with `count` on `fileexists()`/`file()` over
# the build outputs. That breaks a split plan/apply pipeline: Terraform evaluates
# locals in BOTH phases, the build mutates those very files between them, and the
# functions then return different values across phases —
# "function returned an inconsistent result", and the apply aborts.
#
# So Terraform makes no decision from build outputs. The data source ALWAYS runs
# (at plan time, once), and the program itself fingerprints its inputs and skips
# the expensive `npm ci && next build` when nothing changed. The result is always
# a consistent JSON object naming the two artifact directories, so archive_file
# and the upload module have a stable, plan-time value to consume.
#
# HEREDOC ESCAPING
# Terraform only treats `${` as special in this heredoc, and `$${` is its escape
# for a literal `${`. A bare `$` is passed through untouched, so shell variables
# are written `$VAR` / `$(cmd)` as normal, and only bash parameter expansions that
# genuinely need braces — `${HASH:0:12}`, `${PORT:-8080}` — are written `$${…}`.

locals {
  # Absolute, because the external program's working directory is Terraform's,
  # which changes under `terraform -chdir=…`.
  web_dir = abspath("${path.module}/../web")

  # The only value substituted into the script (the web dir) is injected via
  # replace() rather than interpolation, so it can't collide with heredoc syntax.
  build_script = replace(local.build_script_template, "__WEB_DIR__", local.web_dir)

  build_script_template = <<-SCRIPT
    set -euo pipefail

    # data.external contract: stdout must contain ONLY a flat JSON object of
    # strings. Park the real stdout on fd 3 and send every log line to stderr,
    # which Terraform surfaces when the build fails.
    exec 3>&1 1>&2

    # Consume the query JSON so the pipe never blocks; its contents are unused.
    cat >/dev/null || true

    cd "__WEB_DIR__"

    STAMP=".build-stamp"

    sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }

    # Fingerprint everything that can change the output: the configs and every
    # source file under app/components/lib/public (path AND content, so a rename
    # counts). Sorted for stability. Every branch is guarded so a missing config
    # or a missing directory (public/ is optional) can't return non-zero and trip
    # `set -e`/`pipefail` — which would abort the hash before the build even ran.
    current_hash() {
      {
        for f in package.json package-lock.json next.config.mjs postcss.config.mjs \
                 tailwind.config.ts tsconfig.json; do
          if [ -f "$f" ]; then printf 'CFG %s\n' "$f"; cat "$f"; fi
        done
        for d in app components lib public; do
          [ -d "$d" ] || continue
          find "$d" -type f -print0
        done | sort -z | while IFS= read -r -d "" f; do printf 'SRC %s\n' "$f"; cat "$f"; done
      } | sha | cut -d" " -f1
    }

    HASH="$(current_hash)"

    # Skip the heavy build only if the fingerprint matches AND the artifacts are
    # actually on disk — a fresh clone can carry a stale stamp with nothing built.
    if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HASH" ] \
       && [ -f .lambda/server.js ] && [ -f .lambda/run.sh ] && [ -f .static/index.html ]; then
      echo "==> Build up to date (turn $${HASH:0:12}), skipping npm ci + next build"
    else
      echo "==> Inputs changed (turn $${HASH:0:12}), building"

      echo "==> Installing web dependencies (npm ci) in the Terraform runner"
      npm ci --no-audit --no-fund

      echo "==> Building Next.js (standalone output)"
      npm run build

      # The app router prerenders "/" to a plain HTML file because page.tsx is
      # entirely client-side ("use client") with no server data fetching. That
      # document only references /_next/static/*, so it can be served straight
      # from S3 while client-side fetches go to /api/* via CloudFront.
      if [ ! -f .next/server/app/index.html ]; then
        echo "x .next/server/app/index.html missing."
        echo "  The root route stopped being statically prerenderable - check for a"
        echo "  server component, cookies()/headers() call, or force-dynamic in app/."
        exit 1
      fi

      echo "==> Assembling Lambda artifact in .lambda/"
      rm -rf .lambda
      mkdir -p .lambda/.next

      # 1) The self-contained server: server.js + traced node_modules + .next server files.
      cp -R .next/standalone/. .lambda/

      # 2) Static assets are not part of the standalone output. They are served
      #    from S3 now, but keeping them in the bundle means hitting the API
      #    Gateway URL directly still works - handy for debugging CloudFront.
      cp -R .next/static .lambda/.next/static

      # 3) public/ (favicons, images) if present.
      if [ -d public ]; then cp -R public .lambda/public; fi

      # 4) Handler for the AWS Lambda Web Adapter (/opt/bootstrap execs it, then
      #    proxies API Gateway requests to the server over HTTP on $PORT).
      #    Generated here so the repo carries no shell scripts of its own;
      #    lambda.tf pins handler = "run.sh" to this file.
      printf '%s\n' \
        '#!/bin/bash' \
        'set -euo pipefail' \
        '# Generated by terraform/build.tf - do not edit in the artifact.' \
        '# Next standalone honours HOSTNAME; 8080 matches the adapter readiness check.' \
        'export HOSTNAME=0.0.0.0' \
        'export PORT="$${PORT:-8080}"' \
        'exec node server.js' > .lambda/run.sh
      chmod +x .lambda/run.sh

      # 5) Strip any .env* files Next copied in. On Lambda the app must read
      #    config from the function environment (set by Terraform), never a
      #    baked-in .env.local - that would override it and force the dev role.
      find .lambda -maxdepth 1 -name ".env*" -delete

      echo "==> Assembling static frontend in .static/"
      rm -rf .static
      mkdir -p .static/_next
      cp .next/server/app/index.html .static/index.html
      # CloudFront's custom error response points 404s here.
      if [ -f .next/server/app/_not-found.html ]; then
        cp .next/server/app/_not-found.html .static/404.html
      fi
      cp -R .next/static .static/_next/static
      if [ -d public ]; then cp -R public/. .static/; fi

      # Written last: a failed build leaves no stamp, so the next run retries.
      printf "%s" "$HASH" > "$STAMP"
      echo "==> Done."
    fi

    STATIC_FILES="$(find .static -type f | wc -l | tr -d " ")"
    printf '{"static_dir":"%s","lambda_dir":"%s","build_hash":"%s","static_files":"%s"}\n' \
      "__WEB_DIR__/.static" "__WEB_DIR__/.lambda" "$HASH" "$STATIC_FILES" >&3
  SCRIPT
}

data "external" "web_build" {
  program = ["bash", "-c", local.build_script]

  query = {
    # Purely informational: makes the reason for a rebuild visible in the plan.
    project = var.project_name
  }
}

locals {
  static_dir = data.external.web_build.result.static_dir
  lambda_dir = data.external.web_build.result.lambda_dir
  build_hash = data.external.web_build.result.build_hash
}

# Zip the assembled Lambda directory. Consuming local.lambda_dir (which flows from
# the data source) is what orders this after the build at plan time.
data "archive_file" "web_lambda" {
  type        = "zip"
  source_dir  = local.lambda_dir
  output_path = "${path.module}/build/lambda.zip"
}
