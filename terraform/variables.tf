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
  description = "Name of the vector index inside the vector bucket."
  type        = string
  default     = "pages"
}

variable "vector_dimension" {
  description = "Embedding dimension. Must match the Titan Embed Text v2 output size configured in the indexer."
  type        = number
  default     = 1024
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

variable "guardrail_blocked_message" {
  description = "Message shown when the guardrail blocks an off-topic request."
  type        = string
  default     = "Thanks for asking! I'm here to talk about me — my work, my projects, my certifications, and the events I've worked on. For anything outside that, you'll get a much better answer from a specialized AI assistant."
}

variable "daily_budget_usd" {
  description = "Approximate max AI token spend per day (USD) before the app stops generating."
  type        = number
  default     = 0.5
}

variable "ip_daily_message_limit" {
  description = "Max chat messages allowed per public IP per day."
  type        = number
  default     = 50
}

variable "max_input_tokens" {
  description = "Max estimated input tokens accepted per user message."
  type        = number
  default     = 400
}

variable "non_filterable_metadata_keys" {
  description = "Metadata keys that are stored/returned but cannot be used in query filters."
  type        = list(string)
  default     = ["title", "text", "description"]
}

variable "domain_name" {
  description = "Custom hostname to serve the chatbot from, e.g. \"chat.pablo.one\". Leave empty to use the generated API Gateway URL. Must be set together with acm_certificate_arn."
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
  description = "CloudFront TTL in seconds for the static frontend, also used as the objects' Cache-Control max-age. The API is never cached."
  type        = number
  default     = 60
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

variable "web_lambda_memory" {
  description = "Memory (MB) for the Next.js web Lambda. More memory also means more vCPU."
  type        = number
  default     = 1024
}

variable "web_lambda_timeout" {
  description = "Timeout (seconds) for the web Lambda. Capped at 30 to match API Gateway HTTP API's max integration timeout."
  type        = number
  default     = 30
}

variable "lwa_layer_arn" {
  description = "AWS Lambda Web Adapter layer version ARN (arm64) for this region. Proxies API Gateway requests to the Next.js server."
  type        = string
  default     = "arn:aws:lambda:eu-central-1:753240598075:layer:LambdaAdapterLayerArm64:25"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the web Lambda."
  type        = number
  default     = 14
}
