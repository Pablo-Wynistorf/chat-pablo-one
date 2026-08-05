# Builds the web app as part of `terraform apply`, producing both artifacts:
#
#   web/.static/  -> uploaded to S3 object-by-object, served through CloudFront
#   web/.lambda/  -> zipped by data.archive_file, deployed as the API Lambda
#
# Everything lives here: there are no shell scripts in the repo. npm dependencies
# are installed by this step too, so a clean checkout needs nothing but Node, npm
# and Terraform.
#
# WHY A DATA SOURCE, NOT A PROVISIONER
# `aws_s3_object.for_each` and `data.archive_file` are both resolved during PLAN,
# so the artifacts must exist by then. A `local-exec` provisioner runs during
# apply — too late; on a fresh clone the upload module would enumerate an empty
# directory and deploy nothing. Data sources read at plan time, so one
# `terraform apply` works from a clean checkout.
#
# WHY THE BUILD IS SKIPPED MOST OF THE TIME
# Terraform fingerprints the inputs itself (locals below) and compares that with
# web/.build-stamp. Unchanged sources mean `count = 0` and the build never starts,
# so a plan stays fast without the program having to guess when it can no-op.
# The reason for a rebuild is visible in the plan instead of buried in a script.

locals {
  # Absolute, because the external program's working directory is Terraform's,
  # which changes under `terraform -chdir=…`.
  web_dir    = abspath("${path.module}/../web")
  static_dir = "${local.web_dir}/.static"
  lambda_dir = "${local.web_dir}/.lambda"
  stamp_file = "${local.web_dir}/.build-stamp"

  # --- What the build output depends on ---------------------------------------

  # Listed rather than globbed at the root, so generated files that sit next to
  # the configs (tsconfig.tsbuildinfo, .env.local) can't trigger a rebuild.
  web_config_files = [
    for f in [
      "package.json",
      "package-lock.json",
      "next.config.mjs",
      "postcss.config.mjs",
      "tailwind.config.ts",
      "tsconfig.json",
    ] : f if fileexists("${local.web_dir}/${f}")
  ]

  web_source_files = sort(tolist(setunion(
    fileset(local.web_dir, "app/**"),
    fileset(local.web_dir, "components/**"),
    fileset(local.web_dir, "lib/**"),
    fileset(local.web_dir, "public/**"),
    toset(local.web_config_files),
  )))

  # Path-and-content, so a rename alone still counts as a change.
  web_source_hash = sha256(join("\n", [
    for f in local.web_source_files : "${f}:${filesha256("${local.web_dir}/${f}")}"
  ]))

  # The build recipe is an input like any other: edit the script below and the
  # artifacts are rebuilt. Hashed before path substitution so the fingerprint
  # doesn't change just because the repo was cloned somewhere else.
  build_fingerprint = sha256(join("\n", [
    local.web_source_hash,
    sha256(local.build_script_template),
  ]))

  # --- Is a build needed at all? ---------------------------------------------

  # A stamp on its own isn't enough: the artifacts are gitignored, so a fresh
  # clone can have a matching stamp with nothing built. Probe the outputs too.
  artifacts_present = alltrue([
    fileexists("${local.lambda_dir}/server.js"),
    fileexists("${local.lambda_dir}/run.sh"),
    fileexists("${local.static_dir}/index.html"),
  ])

  # try(): file() errors on a missing stamp, and a conditional wouldn't help
  # because Terraform evaluates it eagerly.
  recorded_fingerprint = try(trimspace(file(local.stamp_file)), "")

  build_needed = !local.artifacts_present || local.recorded_fingerprint != local.build_fingerprint

  # --- The build itself -------------------------------------------------------

  # Placeholders instead of direct interpolation: `${…}` inside this heredoc is
  # Terraform syntax, and the substituted values must stay out of the hash above.
  build_script_template = <<-SCRIPT
    set -euo pipefail

    # data.external contract: stdout must contain ONLY a flat JSON object of
    # strings. Park the real stdout on fd 3 and send every log line to stderr,
    # which Terraform surfaces when the build fails.
    exec 3>&1 1>&2

    cd "__WEB_DIR__"

    echo "==> Installing web dependencies (npm ci) in the Terraform runner"
    npm ci --no-audit --no-fund

    echo "==> Building Next.js (standalone output)"
    npm run build

    # The app router prerenders "/" to a plain HTML file because page.tsx is
    # entirely client-side ("use client") with no server data fetching. That
    # document only references /_next/static/*, so it can be served straight from
    # S3 while client-side fetches go to /api/* via CloudFront.
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

    # 2) Static assets are not part of the standalone output. They are served from
    #    S3 now, but keeping them in the bundle means hitting the API Gateway URL
    #    directly still works - useful for debugging CloudFront without a deploy.
    cp -R .next/static .lambda/.next/static

    # 3) public/ (favicons, images) if present.
    if [ -d public ]; then cp -R public .lambda/public; fi

    # 4) Handler for the AWS Lambda Web Adapter (/opt/bootstrap execs it, then
    #    proxies API Gateway requests to the server over HTTP on $$PORT). Written
    #    here so the repo carries no shell scripts of its own. lambda.tf pins
    #    handler = "run.sh" to this file.
    printf '%s\n' \
      '#!/bin/bash' \
      'set -euo pipefail' \
      '# Generated by terraform/build.tf - do not edit in the artifact.' \
      '# Next standalone honours HOSTNAME; 8080 matches the adapter readiness check.' \
      'export HOSTNAME=0.0.0.0' \
      'export PORT="$${PORT:-8080}"' \
      'exec node server.js' > .lambda/run.sh
    chmod +x .lambda/run.sh

    # 5) Strip any .env* files Next copied in. On Lambda the app must read config
    #    from the function environment (set by Terraform), never a baked-in
    #    .env.local - that would override it and force the local dev role.
    find .lambda -maxdepth 1 -name '.env*' -delete

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

    # Written last: a failed build leaves no stamp, so the next plan retries.
    printf '%s' '__BUILD_HASH__' > .build-stamp

    echo "==> Done."
    printf '{"static_dir":"%s","lambda_dir":"%s","build_hash":"%s"}\n' \
      "__WEB_DIR__/.static" "__WEB_DIR__/.lambda" '__BUILD_HASH__' >&3
  SCRIPT

  build_script = replace(
    replace(local.build_script_template, "__WEB_DIR__", local.web_dir),
    "__BUILD_HASH__", local.build_fingerprint,
  )
}

data "external" "web_build" {
  count = local.build_needed ? 1 : 0

  program = ["bash", "-c", local.build_script]
}

# Consuming the data source (rather than only local.*_dir) is what orders the
# plan-time reads: archive_file and the upload module's fileset() must not run
# until the build has finished. one() + coalesce keeps this valid when count = 0,
# where a `[0]` index would fail.
locals {
  built_static_dir = coalesce(one(data.external.web_build[*].result.static_dir), local.static_dir)
  built_lambda_dir = coalesce(one(data.external.web_build[*].result.lambda_dir), local.lambda_dir)
  build_hash       = coalesce(one(data.external.web_build[*].result.build_hash), local.build_fingerprint)
}

data "archive_file" "web_lambda" {
  type        = "zip"
  source_dir  = local.built_lambda_dir
  output_path = "${path.module}/build/lambda.zip"
}
