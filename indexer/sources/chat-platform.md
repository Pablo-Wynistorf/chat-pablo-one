---
title: How this chat platform works — architecture, data and cost
url: https://github.com/Pablo-Wynistorf/chat-pablo-one
section: platform
description: How Pablo's AI chat is built — the AWS architecture, how the data is stored and retrieved, and what it costs per month to run.
---

# How this chat is built

This chat is a retrieval-augmented generation (RAG) chatbot that Pablo built himself. It
answers questions about him in the first person, grounded in his own content, and cites the
pages it drew from. It runs entirely serverless on AWS in the eu-central-1 (Frankfurt)
region, and the whole thing is deployed from Terraform with a single `terraform apply`.

Written in one sentence: the visitor's question is turned into a vector, the closest
passages from Pablo's website, GitHub and LinkedIn are looked up in Amazon S3 Vectors, and
those passages are handed to Amazon Bedrock as context so the model answers from real
material instead of improvising.

## The request path

Everything enters through a single Amazon CloudFront distribution, which fans out to two
origins. That one distribution is also where the TLS certificate lives, so the custom
domain and the certificate are configured in exactly one place.

The first origin is an Amazon S3 bucket holding the built frontend. Pablo's chat page is a
Next.js 14 App Router application with React and Tailwind CSS, and the page itself is
entirely client-side, so Next prerenders it to a plain HTML document at build time. That
document plus the hashed JavaScript and CSS assets are uploaded to S3 and served from the
edge, cached for one minute. The bucket is private: it has no public access whatsoever and
is readable only by CloudFront, through an Origin Access Control signed request.

The second origin is an API Gateway HTTP API, reached only through the `/api/*` path
pattern on the same distribution. Behind it sits a single AWS Lambda function on arm64 with
1024 MB of memory, running the Next.js server through the AWS Lambda Web Adapter. That
behaviour has caching switched off completely, because answers are streamed and the opening
greeting is personalised per visitor. Compression is switched off on that path too — letting
the edge compress a streamed response would make it buffer, which would break the
token-by-token streaming.

Splitting it this way means the Lambda no longer serves static files at all. Every asset
request is answered by CloudFront or S3, and the function only ever runs for actual API
calls.

When someone asks a question, the API route embeds the question with Amazon Titan Text
Embeddings V2 into a 1024-dimension vector, queries Amazon S3 Vectors for the nearest
passages, assembles them into a prompt, and streams the answer back token by token from
Amazon Nova Micro via the Bedrock Converse streaming API. Sources are sent ahead of the
answer in a response header so the citation chips can render before the text arrives.

## How the data is stored

Three kinds of storage, each doing one job: an S3 bucket for the built frontend, an S3
Vectors index for everything searchable, and a small DynamoDB table for usage counters.

There is no database and no vector database cluster. Everything searchable lives in
**Amazon S3 Vectors**, a purpose-built vector store, in one vector bucket with a single
index named `pages`. The index is configured as float32, 1024 dimensions, cosine distance.

The corpus is about 1,956 vectors totalling roughly 11.7 MB. Each vector is one chunk of
text and carries the passage itself alongside it as metadata, so a single query returns both
the ranking and the material the model needs — there is no second fetch. Prose is chunked
into overlapping windows of 220 words with 40 words of overlap; source code uses a
line-aligned splitter so functions are not cut mid-body.

Metadata is split deliberately. The fields `title`, `text` and `description` are stored and
returned but are not filterable. The fields `url`, `section`, `repo`, `path` and `language`
stay filterable, and that is what makes the retrieval trick work: source code is about 96%
of the index, so an unfiltered search returns code for almost any question. Instead the app
runs two filtered queries in parallel — one excluding the code section, one containing only
it — and blends the results according to whether the question actually looks like it is
about code.

Source-code chunks get extra care so that code questions get accurate answers. Files are
split on natural boundaries — a chunk tries to end at a blank line or the start of the next
function, class or resource rather than at an arbitrary line count, so a function is rarely
cut in half. Each chunk is stored with a small header naming the file, its line range, and
the definitions it contains (its functions, classes, Terraform resources, and so on). That
header is embedded alongside the code, which is what lets a plain-English question like "how
does the greeting pick a language" match the chunk that actually defines that logic, instead
of one that merely mentions it.

Four sources feed the index: the pablo.one website discovered through its sitemap, public
GitHub repositories with their READMEs, the actual source files from those repositories, and
hand-written markdown notes for things that cannot be crawled. LinkedIn blocks automated
crawling and returns HTTP 999 to bots, so the LinkedIn content is a curated file rather
than a scrape. The chunk files are committed to the Git repository, which is what lets a
single `terraform apply` embed and load them without needing to crawl anything.

A small Amazon DynamoDB table tracks usage: the running AI spend per day and a per-IP
message count. Every item has a TTL so the counters clean themselves up after about two
days. Nothing about visitors is stored beyond those counters.

## Safety and cost controls

An Amazon Bedrock Guardrail restricts the conversation to topics about Pablo, so off-topic
questions and prompt-injection attempts get a polite refusal. A daily budget cap converts
the real token usage of every model call into micro-dollars and accumulates it in DynamoDB;
once the day's spend reaches the configured limit the chat stops generating and the greeting
falls back to a static message. There is also a per-IP daily message limit and a maximum
length per message, both rejected before any model call is made. All of these fail open: if
the tracking table is unreachable the chat still works.

## What it costs to run per month

Every component is usage-based, so the bill scales with traffic and there is no idle cost.
There is no NAT gateway, no load balancer, no always-on search cluster and no managed
database — the things that normally dominate an AWS bill are simply absent.

The unit prices in eu-central-1 are: AWS Lambda on arm64 at $0.0000133334 per GB-second and
$0.20 per million requests; API Gateway HTTP API at $1.20 per million requests; Nova Micro
at $0.000035 per thousand input tokens and $0.00014 per thousand output tokens; Titan Text
Embeddings V2 at $0.0002 per thousand tokens; and S3 Vectors at $0.064 per GB-month of
storage plus $0.214 per GB written.

At the traffic a personal portfolio actually gets — on the order of a few hundred visits and
a few hundred chat messages a month — the total lands at roughly **10 to 20 US cents per
month**. Storing the entire vector index costs about $0.0007 per month, or seven hundredths
of a cent. A few hundred chat messages cost around five cents in Bedrock tokens. API Gateway
adds under a cent. Lambda usually costs nothing at all, because its perpetual free tier of
one million requests and 400,000 GB-seconds per month comfortably covers this workload.
CloudWatch Logs, with 14-day retention, is typically the second largest line after Bedrock,
and still only pennies.

CloudFront and the frontend bucket add effectively nothing. CloudFront has a perpetual free
tier of one terabyte of data transfer out and ten million requests per month, which a
personal site will not come close to exhausting, and the distribution is limited to the
North America and Europe edge locations to keep the per-request rate at its lowest. The
frontend itself is well under a megabyte of hashed assets, so S3 storage is a rounding error,
and the one-minute edge cache means CloudFront rarely goes back to the bucket at all. Putting
the CDN in front actually reduces cost slightly, because the Lambda stopped serving static
files and now runs only for real API calls.

Re-indexing is the one noticeable expense. Embedding the whole corpus costs about **$0.22**
in Titan tokens, because it is roughly 1.1 million tokens and the source code is about 96%
of that. That is why the deployment only re-embeds when the content hash actually changes,
rather than on every apply.

The worst case is bounded by design rather than by hope. The daily AI budget cap means model
spend cannot exceed about $15 in a month even under sustained abuse, and the per-IP message
limit makes reaching that ceiling difficult in the first place. For comparison, the obvious
managed alternatives would cost far more while sitting idle: Amazon OpenSearch Serverless
and Aurora Serverless both bill for provisioned capacity whether or not anyone runs a query,
which is the wrong shape entirely for a site that might get a handful of visits a day. That
trade-off is the main reason the project uses S3 Vectors.

## The personalised greeting

The first message is generated fresh on every page load and personalised from what the
single greeting request reveals: the browser and operating system, the device type, the
preferred language, the connection quality, the visitor's approximate city, and their local
time of day. Chromium's high-entropy Client Hints are requested with an `Accept-CH` header
so details like the exact browser version and platform are available; because the document
is served from S3, which cannot return arbitrary headers, that header is added by a
CloudFront response headers policy at the edge.

Location comes from a keyless IP geolocation lookup, capped by a short timeout and cached
per address for six hours. CloudFront can also attach headers describing the viewer's city,
country, timezone and network, and the code prefers those when present — but they are not
switched on here. Those headers are only accepted in a CloudFront origin request policy, and
such a policy is limited to ten headers in total, which is not enough room to also forward
the Content-Type, User-Agent, Accept-Language and Client Hint headers the API actually needs.
Breaking the JSON request to avoid one cached lookup would be a poor trade.

Every one of those values is treated as untrusted input, sanitised and bounded before it
goes anywhere near the model prompt. The interface shows its own working through a "How did
I know that?" panel under the greeting.

## Deployment

Terraform provisions everything: the vector bucket and index, the frontend bucket, the
CloudFront distribution, the guardrail, the usage table, the IAM roles, the Lambda function
and the API Gateway. It also runs the build itself and uploads the result, so one
`terraform apply` takes the project from an empty account to a working, populated chatbot.

The build runs as a Terraform external data source rather than a provisioner. That is
deliberate: the S3 upload manages every file as an individual Terraform resource, and
Terraform resolves those at plan time, so the built files have to exist before planning
begins. A provisioner only runs during apply, which would be too late on a fresh clone. The
build stamps a hash of its inputs and skips itself when nothing changed, so repeated plans
stay fast.

Uploading through managed resources rather than a sync command means Terraform can show
exactly which assets change, and deleting a source file deletes the object. A new build also
triggers a CloudFront invalidation, because the HTML document keeps the same name while its
contents change. A custom domain and an ACM certificate can be supplied as Terraform
variables; the certificate must be issued in us-east-1, since that is the only region
CloudFront accepts certificates from. State is kept locally because this is a proof of
concept.
