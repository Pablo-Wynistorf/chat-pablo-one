# Every input is a string: TerraForge writes project variables to terraform.tfvars
# as quoted strings (KEY = "value"). Numbers and lists are converted in the locals
# block at the bottom. Values must not contain double quotes or backslashes, and
# all project variables together must fit in 4 KB.

variable "region" {
  description = "AWS region. S3 Vectors + Bedrock Titan v2 must both be available here."
  type        = string
  default     = "eu-central-1"
}

variable "project_name" {
  description = "Short name used as a prefix for created resources."
  type        = string
  default     = "pablo-one-poc"
}

variable "cost_center" {
  description = "Cost allocation tag value applied to all resources. Activate 'CostCenter' as a cost allocation tag in AWS Billing to break down spend."
  type        = string
  default     = "pablo-one-poc"
}

variable "index_name" {
  description = "Name of the vector index inside the vector bucket. Changing it replaces the index, which prevent_destroy blocks."
  type        = string
  default     = "pages"
}

variable "vector_dimension" {
  description = "Embedding dimension (number). Must match the Titan Embed Text v2 output size configured in the indexer."
  type        = string
  default     = "1024"
}

variable "distance_metric" {
  description = "Similarity metric for the index. Valid values: cosine, euclidean."
  type        = string
  default     = "cosine"
}

variable "bedrock_model_id" {
  description = "Bedrock embedding model id. Access must be enabled per-account in the Bedrock console."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "chat_model_id" {
  description = "Bedrock text-generation model (inference profile) used by the RAG chatbot. Nova Micro = cheapest + fastest."
  type        = string
  default     = "eu.amazon.nova-micro-v1:0"
}

variable "site_url" {
  description = "Root URL of the website to index."
  type        = string
  default     = "https://www.pablo.one"
}

variable "cors_allowed_origins" {
  description = "Comma-separated browser origins (scheme://host[:port], no trailing slash) allowed to call the API cross-origin. The chat page itself is same-origin and doesn't need an entry."
  type        = string
  default     = "https://pablo.one,https://www.pablo.one,http://localhost,http://localhost:3000"
}

variable "guardrail_blocked_message" {
  description = "Message shown when the guardrail blocks an off-topic request."
  type        = string
  default     = "Thanks for asking! I'm here to talk about me — my work, my projects, my certifications, and the events I've worked on. For anything outside that, you'll get a much better answer from a specialized AI assistant."
}

variable "daily_budget_usd" {
  description = "Approximate max AI token spend per day (USD, number) before the app stops generating."
  type        = string
  default     = "0.5"
}

variable "ip_daily_message_limit" {
  description = "Max chat messages allowed per public IP per day (number)."
  type        = string
  default     = "50"
}

variable "max_input_tokens" {
  description = "Max estimated input tokens accepted per user message (number)."
  type        = string
  default     = "400"
}

variable "non_filterable_metadata_keys" {
  description = "Comma-separated metadata keys that are stored/returned but cannot be used in query filters. Changing it replaces the index, which prevent_destroy blocks."
  type        = string
  default     = "title,text,description"
}

variable "domain_name" {
  description = "Custom hostname to serve the chatbot from, e.g. chat.pablo.one. Leave empty to use the generated CloudFront hostname. Must be set together with acm_certificate_arn."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain_name))
    error_message = "domain_name must be a bare lowercase hostname with no scheme, port or trailing slash (e.g. \"chat.pablo.one\")."
  }
}

variable "acm_certificate_arn" {
  description = "ARN of an ACM certificate covering domain_name. The certificate sits on CloudFront, so it MUST be issued in us-east-1 regardless of var.region. Must be set together with domain_name."
  type        = string
  default     = ""

  validation {
    condition     = var.acm_certificate_arn == "" || can(regex("^arn:aws[a-z-]*:acm:us-east-1:[0-9]{12}:certificate/", var.acm_certificate_arn))
    error_message = "acm_certificate_arn must be a full ACM certificate ARN issued in us-east-1 (CloudFront only accepts us-east-1 certificates), e.g. \"arn:aws:acm:us-east-1:123456789012:certificate/abc-123\"."
  }
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone ID. When set (together with domain_name), Terraform creates the A/AAAA alias records so the deploy needs no manual DNS step. Leave empty if DNS is managed elsewhere and use the dns_record output."
  type        = string
  default     = ""
}

variable "frontend_cache_ttl" {
  description = "CloudFront TTL in seconds (number) for the static frontend. The API is never cached."
  type        = string
  default     = "60"
}

variable "cloudfront_price_class" {
  description = "CloudFront edge locations to use. PriceClass_100 (NA + EU) is the cheapest and covers this site's audience; PriceClass_All adds the rest of the world."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "api_lambda_memory" {
  description = "Memory (MB, number) for the api Lambda. More memory also means more vCPU."
  type        = string
  default     = "1024"
}

variable "api_lambda_timeout" {
  description = "Timeout (seconds, number) for the api Lambda. Keep at or below 30, the API Gateway HTTP API integration ceiling."
  type        = string
  default     = "30"
}

variable "indexer_lambda_memory" {
  description = "Memory (MB, number) for the indexer Lambda."
  type        = string
  default     = "1024"
}

variable "indexer_lambda_timeout" {
  description = "Timeout (seconds, number) for the indexer Lambda. A full re-embed of the corpus is the slow case."
  type        = string
  default     = "900"
}

variable "indexer_schedule" {
  description = "EventBridge schedule expression for the indexer, e.g. rate(1 day) or cron(0 3 * * ? *). Empty disables the schedule (manual invokes only)."
  type        = string
  default     = "rate(1 day)"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention (days, number) for both Lambda functions."
  type        = string
  default     = "14"
}

locals {
  vector_dimension       = tonumber(var.vector_dimension)
  daily_budget_usd       = tonumber(var.daily_budget_usd)
  ip_daily_message_limit = tonumber(var.ip_daily_message_limit)
  max_input_tokens       = tonumber(var.max_input_tokens)
  frontend_cache_ttl     = tonumber(var.frontend_cache_ttl)
  api_lambda_memory      = tonumber(var.api_lambda_memory)
  api_lambda_timeout     = tonumber(var.api_lambda_timeout)
  indexer_lambda_memory  = tonumber(var.indexer_lambda_memory)
  indexer_lambda_timeout = tonumber(var.indexer_lambda_timeout)
  log_retention_days     = tonumber(var.log_retention_days)

  cors_allowed_origins         = [for o in split(",", var.cors_allowed_origins) : trimspace(o) if trimspace(o) != ""]
  non_filterable_metadata_keys = [for k in split(",", var.non_filterable_metadata_keys) : trimspace(k) if trimspace(k) != ""]
}
