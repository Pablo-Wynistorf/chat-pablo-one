# Ask-about-Pablo — RAG chatbot on Amazon S3 Vectors

A proof-of-concept chatbot that answers questions about Pablo Wynistorf. It ingests his
**website, GitHub projects, LinkedIn, and curated background notes** into a **single S3
Vectors index**, then answers questions by semantically retrieving the most relevant
passages and having Bedrock Nova Micro compose a grounded answer with clickable citations.

```
                        ┌──────────── CloudFront ────────────┐
                        │  ACM cert · custom domain          │
   visitor  ──────────► │                                    │
                        │  default  ──► S3   (frontend, 60s) │
                        │  /api/*   ──► API Gateway (no cache)│
                        └────────────────────┬───────────────┘
                                             ▼
                                    Lambda (arm64, LWA)
                                    /api/chat · /api/greeting
        ┌────────────────────────────────────┤
        │  1) embed question                 │  2) topK nearest chunks
        ▼                                    ▼
   Bedrock Titan Embed v2 (1024-dim)   ┌── S3 Vectors ─────────────────┐
   Bedrock Nova Micro (streaming)      │  one index: "pages"           │
                                       │  one vector per source-chunk  │
                                       │  website · github · linkedin  │
                                       └───────────────────────────────┘

Ingest: website(sitemap) + GitHub(repos/READMEs) + sources/*.md → chunk → embed → PutVectors
```

**Two origins, one distribution.** The page is a client component with no server data
fetching, so Next prerenders it to a static document; that plus the hashed assets live in a
private S3 bucket (Origin Access Control — no public access) and are cached at the edge for
60 seconds. `/api/*` goes to API Gateway with caching and compression both off, because the
answers are streamed and the greeting is per-visitor. The Lambda therefore never serves a
static file — it runs only for real API calls.

## Safety, cost & abuse controls

Every chat request passes through these gates (see `web/lib/usage.ts` + `web/lib/chat.ts`):

- **Bedrock Guardrail** — a `topic_policy` guardrail (Terraform: `guardrail.tf`) restricts
  the bot to talking about Pablo. Off-topic asks (general knowledge, coding help, other
  people) and prompt-injection attempts are blocked and get a polite on-brand refusal.
- **Daily cost budget (~$0.50/day)** — real token usage from every Nova Micro call (chat
  *and* the on-load greeting) is converted to micro-USD and accumulated in DynamoDB under
  `cost#<day>`. Once the day's spend hits `DAILY_BUDGET_USD`, chat returns a friendly
  "come back tomorrow" and the greeting falls back to a static message (no model spend).
- **Per-IP daily limit (50 messages)** — each public IP's messages are counted in DynamoDB
  under `ip#<day>#<ip>`; the 51st request that day is rejected. Requests rejected earlier
  (e.g. too-long input) don't count.
- **Per-message input limit** — messages over `MAX_INPUT_TOKENS` (~400, estimated) are
  rejected with a 413 before any model call.

DynamoDB items carry a TTL so counters self-clean after ~2 days. Limits **fail open**: if
the tracking table is unreachable the chat still works (errors are logged), so tune to
taste. All thresholds live in `web/.env.local` (`DAILY_BUDGET_USD`, `IP_DAILY_LIMIT`,
`MAX_INPUT_TOKENS`) and token prices can be overridden (`CHAT_IN_PER_1K`, etc.).

## Personalised greeting

The opening message is generated per page load from whatever the *single* greeting request
reveals about the visitor (`web/lib/visitor.ts` → `web/app/api/greeting/route.ts`), so it can
open with something like *"Afternoon in Dagmersellen — nice to see you over from LinkedIn."*

Three signal sources, no extra round-trips:

| Source | Gives us |
| --- | --- |
| Request headers | browser + version, OS + version, device type & model, CPU arch, languages, dark mode, connection quality (`ECT`/`RTT`/`Downlink`), data-saver |
| IP address | city, region, country + flag, timezone, ISP + ASN |
| Query params on the greeting fetch | real timezone, screen size & DPR, cores, RAM, `document.referrer`, returning-visitor count |

Three details worth knowing:

- **Client Hints.** Chromium only sends the low-entropy set by default. `next.config.mjs`
  returns an `Accept-CH` header so later requests — including the greeting fetch — carry the
  high-entropy hints. That's the difference between "Chrome on Windows" and
  "Chrome 140 on Windows 11, ARM64, dark mode". Firefox and Safari ignore this, so they fall
  back to User-Agent parsing.
- **Why the query params.** Headers can't supply these: the IP's timezone is wrong behind a
  VPN, and a same-origin fetch's `Referer` is the page itself, losing the real referrer.
- **The referrer comes only from `document.referrer`.** The `Referer` header is never used
  as a fallback. This endpoint is fetched same-origin, so that header is *always* this
  app's own page — treating it as a referrer turned the API Gateway hostname into a
  confident "you popped in through Amazon". Self-host is read from `X-Forwarded-Host`/`Host`
  rather than `req.url`, because behind the Lambda Web Adapter `req.url` is the internal
  `localhost:8080`. Infra hostnames (`*.execute-api.*.amazonaws.com`, `*.cloudfront.net`,
  `*.lambda-url.*.on.aws`, …) are rejected outright.

### Geo: prefer the edge

Geo resolution tries three sources in order, and only the last one costs anything:

1. **CloudFront** — `CloudFront-Viewer-City/-Country/-Time-Zone/-ASN`. Supported in code but
   **not enabled**, deliberately. These headers are only accepted in an *origin request*
   policy, which is capped at 10 headers — too few to also carry `Content-Type`,
   `User-Agent`, `Accept-Language` and the Client Hints. The `/api/*` behaviour therefore
   uses the managed `AllViewerExceptHostHeader` policy (the Host exception matters: API
   Gateway 403s on an unfamiliar Host) and geo falls through to step 3. Putting these in the
   *cache* policy instead does not work — it rejects them.
2. **Cloudflare** — `CF-IPCountry` arrives automatically on proxied traffic. City, region
   and timezone need the *Add visitor location headers* managed transform switched on
   (Cloudflare dashboard → Rules → Settings). Cloudflare exposes no ASN/ISP header, so
   those fields stay blank.
3. **IP lookup** — a keyless HTTP call, capped by a timeout and cached per IP for 6h.
   Defaults to `ipinfo.io`, which resolves to city level. Picking a provider matters more
   than it looks: for the OVH address `51.195.24.96` (a server in Frankfurt) geojs.io
   returned *France* with a Paris centroid, because it falls back to the ASN's
   registration country and OVH SAS is French. ipinfo returned *Frankfurt am Main, DE*.

Datacenter, VPN and corporate-egress addresses are the cases that go wrong. Geo is only
stated as fact when the provider resolved a **city**; a country-only answer is the
signature of that ASN fallback, so it's passed to the model flagged as unreliable rather
than becoming a confident "you're in France".

If the site is served through Cloudflare, enabling that one managed transform removes the
third-party lookup from the hot path entirely: no network call, no rate limit, and it fixes
the ~400 ms geo timeout budget. Configure the fallback with:

```
GEO_API_URL=https://get.geojs.io/v1/ip/geo/{ip}.json   # keyless default; ipinfo.io/{ip}/json also works
GEO_TIMEOUT_MS=900                                      # lookup is capped and cached per IP for 6h
VISITOR_HIDE_IP=true                                    # mask the last octet (default: show in full)
```

Everything here is best-effort: a failed lookup or a missing header costs one detail, never the
greeting. Over budget, a deterministic (still time- and place-aware) greeting is served with no
model spend. The UI shows its working under the greeting via a *"How did I know that?"* toggle.

**Untrusted input.** Every field is attacker-controlled and lands in a model prompt, so nothing
is forwarded raw: strings pass a character allow-list and length cap, enumerated hints
(`Sec-CH-UA-Platform`, `-Arch`) are matched against known values and otherwise dropped, numbers
are range-checked, the raw User-Agent is never sent to the model, and referrers collapse to a
known label or bare hostname.

## Repository layout

```
pablo.one-poc/
├── terraform/   # vector bucket + index "pages" + least-privilege IAM role (local state)
├── indexer/     # ingest sources -> data/*.json -> embed + insert vectors
│   ├── crawl.ts        # website (sitemap.xml)          -> data/pages.json
│   ├── github.ts       # GitHub repos + READMEs          -> data/github.json
│   ├── docs.ts         # curated markdown in sources/    -> data/docs.json
│   ├── sources/        # editable .md docs (LinkedIn, background research)
│   └── embed_and_insert.ts  # merges data/*.json, embeds, upserts, prunes stale
├── web/         # Next.js 14 App Router + Tailwind RAG chatbot
└── README.md
```

## How it works

The chatbot is retrieval-augmented (RAG): semantic search finds the most relevant passages
across **multiple sources**, and Bedrock Nova Micro writes a grounded answer that cites them.

1. **Ingest** — each source script extracts text and splits it into overlapping
   word-windows ("chunks"), writing a `data/<source>.json`:
   - `crawl.ts` — the website, discovered via `sitemap.xml`.
   - `github.ts` — every non-fork public repo for `GITHUB_USER`, combining repo metadata
     with the README (fetched from `raw.githubusercontent.com`, so no API rate limit).
   - `docs.ts` — hand-curated markdown in `sources/` (LinkedIn — which blocks scraping —
     and researched background facts). This is the "train it on more data" hook: drop a
     new `.md` file in `sources/` with a small front-matter header and re-run.
2. **Embed + insert** — `embed_and_insert.ts` merges every `data/*.json`, embeds each chunk
   with Titan Embed Text v2 (1024-dim), upserts one vector per chunk (metadata: `url`,
   `title`, `description`, `section`, full `text`), then **prunes** any stale vectors so the
   index exactly matches the current data.
3. **Retrieve + generate** — for each question the app embeds the query, does a topK
   nearest-neighbour lookup, feeds the top passages to Nova Micro as grounding context, and
   streams the answer while showing the source pages/repos as clickable citations.

## Prerequisites

- **Node 20+** and npm
- **Terraform 1.6+**
- **AWS CLI** configured for the target account (`aws sts get-caller-identity` works)
- **Bedrock model access** for `amazon.titan-embed-text-v2:0` in **eu-central-1**
  (AWS Console → Bedrock → Model access → enable *Titan Text Embeddings V2*).

## 1. Deploy — one `terraform apply`

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # optional: custom domain, limits
terraform init
terraform apply
```

That single apply does everything:

1. Creates the vector bucket and `pages` index, the frontend bucket, the CloudFront
   distribution, the guardrail, the usage table and the IAM roles.
2. **Builds the app** — `npm ci` then one `next build`, driven entirely by
   `terraform/build.tf` (there are no shell scripts in the repo), producing both
   artifacts: `web/.static/` for S3 and `web/.lambda/` for the API function.
3. **Uploads the frontend** to S3 as individually managed objects, via the local
   `modules/s3-site-upload` module, then invalidates the CloudFront cache.
4. **Embeds the committed chunks in `indexer/data/*.json` and loads them into the index**
   (`indexer/load-index.sh`), so the chatbot can answer as soon as the apply finishes.
5. Attaches your custom domain and, if `route53_zone_id` is set, the DNS records.

The URL is in the `web_url` output. The apply needs **Node 20+, npm and the AWS CLI on the
machine running it**.

> **Why the build is a data source, not a provisioner.** `aws_s3_object.for_each` and
> `data.archive_file` are both resolved during *plan*, so the artifacts must exist by then.
> A `local-exec` provisioner runs during *apply* — too late, and on a fresh clone the upload
> module would enumerate an empty directory and deploy nothing. `data "external"` runs at
> plan time, which makes a single apply work from a clean checkout. Terraform fingerprints
> the build inputs itself (`fileset` + `filesha256` over `web/app`, `web/components`,
> `web/lib`, `web/public` and the configs) and compares that with `web/.build-stamp`, so
> when nothing changed the data source gets `count = 0` and the build never starts.

`indexer/data/*.json` is **committed to the repo on purpose** — that's what makes step 3
possible from a fresh clone. Re-crawling is a separate, deliberate action (step 2 below).

### Custom domain

Set both in `terraform.tfvars`:

```hcl
domain_name         = "chat.pablo.one"
acm_certificate_arn = "arn:aws:acm:us-east-1:…:certificate/…"
```

The certificate goes on CloudFront, so it **must be issued in us-east-1** — the only region
CloudFront accepts certificates from, regardless of where the rest of the stack runs. That's
enforced twice: the variable's own validation rejects a non-us-east-1 ARN, and a resource
precondition catches it again with an explanatory message. Setting only one of the two
variables is rejected up front too.

**DNS.** The zone for this project is not in Route 53, so the record is the one step
Terraform can't do — it has no credentials for the external DNS provider. After the apply:

```bash
terraform output dns_record
# => { type = "CNAME", name = "chat.pablo.one", value = "d111111abcdef8.cloudfront.net" }
```

Create that CNAME at your provider. Two caveats:

- **Apex domains.** A CNAME is invalid at a zone apex. For `pablo.one` itself you need the
  provider's ALIAS/ANAME equivalent, or Cloudflare's CNAME flattening. A subdomain like
  `chat.pablo.one` is a plain CNAME and just works.
- **Cloudflare proxy mode.** Either works. Proxied (orange cloud) requires SSL mode
  *Full (strict)*, which the ACM certificate satisfies since CloudFront serves it for
  `domain_name`. Note that proxying puts Cloudflare in front of CloudFront, so the
  `CF-*` headers win over the `CloudFront-Viewer-*` ones — both are supported.

If the zone ever moves to Route 53, set `route53_zone_id` and Terraform creates the A/AAAA
alias records itself, making the deploy a genuine single command.

### Re-running apply: nothing is embedded twice

Embedding is the only part of this project that costs real money — a full pass over the
corpus is about **$0.22** in Titan tokens — so two independent layers stop it happening
needlessly.

**Terraform** won't run the loader at all unless something relevant changed. The per-file
hashes of `indexer/data/*.json` are recorded in state, alongside the embedding model id and
the index ARN, so `terraform plan` can see the corpus is byte-identical to what's loaded.
`terraform output indexed_corpus` shows which content is currently indexed.

**The loader** is the authoritative check. Every vector carries a `contentHash` in its
metadata — a fingerprint of the embedded text, the stored passage, the metadata and the
model id. On each run the loader lists the index, compares fingerprints, and embeds only
chunks that are new or edited:

```
Chunks on disk         : 1964
Skipped (unchanged)    : 1957
Embedded + written     : 7
Stale deleted          : 0
Estimated Bedrock cost : ~$0.00042
```

Edit one markdown file and only that file's chunks are re-embedded. Run it with nothing
changed and it exits having spent nothing.

That record deliberately lives **in the index**, not in a manifest file or in Terraform
state. A side file can drift — deleted, stale, or left over from a different bucket — and
would then either re-embed everything or, worse, skip chunks that aren't actually there.
The index cannot disagree with itself. Terraform's copy is only an optimisation to avoid
spawning a no-op process.

Changing `bedrock_model_id` invalidates every fingerprint automatically, because the model
id is part of the hash — a model swap re-embeds the corpus instead of leaving a mix of
incompatible vectors in one index. `npm run index -- --force` re-embeds regardless, and
`npm run index:dry-run` reports what a real run would do and what it would cost, using a
read-only listing of the index.

For local development you still want the env file:

```bash
terraform output -raw env_local > ../web/.env.local
```

## 2. Refreshing the indexed data

Ingest is deliberately *not* part of `terraform apply`: it hits the network and its output
isn't deterministic. Re-crawl on purpose, then commit the result:

```bash
cd indexer
npm install
npm run ingest:all    # crawl website + fetch GitHub repos + read sources/*.md
git add data/         # committed, so the next apply picks it up
```

The next `terraform apply` sees the changed hash and re-embeds. To load immediately
without an apply, run `npm run index`.

`ingest:all` runs the sources in sequence; you can also run them individually:

```bash
npm run crawl          # website  -> data/pages.json   (uses SITE_URL)
npm run ingest:github  # GitHub    -> data/github.json  (uses GITHUB_USER, default Pablo-Wynistorf)
npm run ingest:docs    # sources/  -> data/docs.json
```

**Adding more data (training):** create a markdown file in `indexer/sources/`, e.g.

```markdown
---
title: Talk — Cloud at the Edge
url: https://example.com/talk
section: about
---
Notes, transcript, or facts you want the chatbot to know…
```

then re-run `npm run ingest:docs` and either `npm run index` or `terraform apply`. To index a **different** site or
GitHub user, set `SITE_URL` / `GITHUB_USER` in `web/.env.local`. A `GITHUB_TOKEN` is
optional (only needed if you hit the 60 req/hr unauthenticated GitHub API limit).

> **LinkedIn note:** LinkedIn blocks automated crawling (HTTP 999), so it can't be scraped.
> `sources/linkedin.md` is a hand-curated stand-in seeded with public professional facts —
> edit it with your real profile details and re-ingest.

## 3. Run the chatbot

```bash
cd web
npm install
npm run dev
```

Open **http://localhost:3000**, ask a question (or click a suggestion). The answer streams
in and the pages/repos it drew from appear as clickable source chips.

Try: `Who is Pablo?`, `What AWS certifications does he have?`, `What does the aws-nuke repo
do?`, `How many times did he work at Openair Frauenfeld?`

Relevant env knobs (in `web/.env.local`): `CHAT_MODEL_ID` (generation model),
`MIN_SCORE` (search relevance floor), `RAG_MIN_SCORE` (grounding relevance floor).

## 4. Clean up

```bash
cd terraform
terraform destroy -auto-approve
```

`force_destroy = true` on the vector bucket removes the index and all vectors.

## Notes & non-goals

- **No auth** — this is a public-content search POC, so every page is fair game and there
  is no per-user isolation (unlike the sibling multi-tenant email POC).
- **Static-site friendly** — discovery relies on `sitemap.xml`. Hugo/Jekyll/most SSGs
  publish one automatically. Client-rendered SPAs without a sitemap would need a different
  discovery step.
- **Politeness** — the crawler fetches pages sequentially with a descriptive User-Agent.
  For larger sites add rate-limiting / `robots.txt` handling.
- Local Terraform state, `next dev` on localhost. `web/.env.local` holds only ARNs/names,
  no secrets, and is git-ignored.
```
