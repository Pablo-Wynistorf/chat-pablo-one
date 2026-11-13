# AGENTS.md

`chat.pablo.one` is a RAG chatbot about Pablo Wynistorf: a static Next.js page, an
API Lambda that answers with Bedrock over an S3 Vectors index, and an indexer
Lambda that loads the committed corpus into that index. It deploys with
**TerraForge** (self-hosted, AWS). Terraform creates the infrastructure;
TerraForge builds and publishes the frontend and the functions separately.

## Layout

| Folder | TerraForge item | Terraform |
| --- | --- | --- |
| `terraform/` | Terraform directory | root module, no backend |
| `frontends/web/` | frontend `web` | `aws_s3_bucket.web`, `aws_cloudfront_distribution.web` (frontend.tf, cloudfront.tf) |
| `functions/api/` | function `api` | `aws_lambda_function.api` + `aws_lambda_alias.api_live`, API Gateway in api.tf |
| `functions/indexer/` | function `indexer` | `aws_lambda_function.indexer` + `aws_lambda_alias.indexer_live`, EventBridge schedule |

One CloudFront distribution serves both: `/*` from the S3 bucket, `/api/*` from
API Gateway, so the page calls the API same-origin with root-relative URLs.

`functions/indexer/data/*.json` is the corpus and is committed. Refresh it locally
with `npm run ingest:all` (crawl, GitHub, code, docs; needs network and optionally
`GITHUB_TOKEN`), commit, then build and publish the indexer.

## Hard rules

- No `backend` block and no credentials (`profile`, `assume_role`, keys) in any
  provider. TerraForge provides state and credentials. Always set `region`.
- Terraform never uploads site files (`aws_s3_object`) or Lambda code, and avoids
  `local-exec` / `external`.
- `aws_cloudfront_distribution.web` keeps `ignore_changes = [origin]`
  (TerraForge rewrites `origin_path`). Consequence: never let the frontend bucket
  or the API Gateway API be replaced, because CloudFront would keep pointing at
  the old one.
- Lambda functions keep `ignore_changes` on code and the `live` alias keeps
  `ignore_changes = [function_version]`.
- Every trigger targets the `live` alias: API Gateway integration uses
  `aws_lambda_alias.<x>.invoke_arn`, permissions use `qualifier`, the EventBridge
  target uses the alias ARN.
- Each item folder is self-contained (own `package.json`, lockfile,
  `buildspec.yml`). No shared code folder.
- Project variables are all `type = string`; convert with `tonumber()` /
  `split()` in the `locals` block of `variables.tf`.
- One IAM role per function, scoped to the exact resources its code calls.
- No secrets in the repo, in frontend build variables or in unmarked outputs.
  `.env.local` files are local-only and gitignored.
- Renaming a Terraform resource needs a `moved {}` block (see `moved.tf`).

## Releases

Infrastructure, frontend and functions go live and roll back independently, so
every change must work in any order:

- Expand, then contract: add resources/fields first (apply), ship code that uses
  them (publish), remove the old ones in a later release.
- Keep `/api/*` backwards compatible for at least one release.
- Handlers are idempotent. The indexer compares content hashes against the index
  and only writes changed chunks, so re-runs and overlapping versions are safe.
- Lambda environment changes in Terraform reach traffic only after the next
  build of that function is published.

## Data and destroy

Everything is disposable except the **S3 Vectors bucket and index**
(`aws_s3vectors_vector_bucket.this`, `aws_s3vectors_index.pages`), which carry
`prevent_destroy = true` because a full re-embed is slow. Any change that would
replace them (index name, dimension, metric, non-filterable keys) fails at plan
time. A full destroy also stops at these two resources; to tear down the rest
while keeping them, they have to be taken out of this state first (for example
moved to their own TerraForge project) — ask the operator before doing that.

## Builds and local checks

```bash
# Terraform
cd terraform && terraform fmt -recursive && terraform init -backend=false && terraform validate

# Frontend (static export to out/)
cd frontends/web && npm ci && npm run build && test -f out/index.html

# Functions (esbuild bundle, handler dist/index.mjs = "index.handler")
cd functions/api && npm ci && npm run typecheck && npm run build
cd functions/indexer && npm ci && npm run typecheck && npm run build   # also copies data/ into dist/
```

Local development: `cd functions/api && npm run dev` (port 3001) and
`cd frontends/web && npm run dev` (proxies `/api/*` to it). Both function folders
read `.env.local`; fill it from `terraform output env_local`.

Never run `terraform plan`/`apply` against the real account from a laptop;
TerraForge owns state.
