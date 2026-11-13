# --- TerraForge registration -------------------------------------------------

output "web_bucket" {
  description = "S3 bucket of the 'web' frontend (frontends/web). Register it as the frontend's target bucket in TerraForge."
  value       = aws_s3_bucket.web.id
}

output "web_distribution_id" {
  description = "CloudFront distribution of the 'web' frontend. Register it on the frontend in TerraForge; also used for cache invalidations."
  value       = aws_cloudfront_distribution.web.id
}

output "web_url" {
  description = "Public URL of the chatbot: the custom domain when configured, otherwise the CloudFront hostname."
  value       = local.custom_domain_enabled ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "api_function_name" {
  description = "Lambda function of the 'api' function (functions/api). Register it in TerraForge with alias 'live'."
  value       = aws_lambda_function.api.function_name
}

output "indexer_function_name" {
  description = "Lambda function of the 'indexer' function (functions/indexer). Register it in TerraForge with alias 'live'."
  value       = aws_lambda_function.indexer.function_name
}

output "api_url" {
  description = "API Gateway invoke URL. CloudFront routes /api/* here; calling it directly bypasses the CDN."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

# --- Diagnostics -------------------------------------------------------------

output "region" {
  description = "AWS region everything was created in."
  value       = var.region
}

output "cloudfront_domain_name" {
  description = "Generated CloudFront hostname. Always works, even with a custom domain attached; useful for debugging DNS."
  value       = aws_cloudfront_distribution.web.domain_name
}

output "vector_bucket_name" {
  description = "Name of the S3 vector bucket (protected against destroy)."
  value       = aws_s3vectors_vector_bucket.this.vector_bucket_name
}

output "index_name" {
  description = "Name of the vector index (protected against destroy)."
  value       = aws_s3vectors_index.pages.index_name
}

output "index_arn" {
  description = "ARN of the vector index."
  value       = aws_s3vectors_index.pages.index_arn
}

output "guardrail_id" {
  description = "Bedrock guardrail identifier applied to chat generation."
  value       = aws_bedrock_guardrail.this.guardrail_id
}

output "guardrail_version" {
  description = "Bedrock guardrail version applied to chat generation."
  value       = aws_bedrock_guardrail.this.version
}

output "usage_table_name" {
  description = "DynamoDB table tracking daily cost and per-IP message counts."
  value       = aws_dynamodb_table.usage.name
}

# The DNS record to create by hand. Terraform manages it only for Route 53 zones.
output "dns_record" {
  description = "DNS record to create for the custom domain. Null when no custom domain is configured, or when Terraform already created it in Route 53."
  value = local.custom_domain_enabled && var.route53_zone_id == "" ? {
    type  = "CNAME"
    name  = var.domain_name
    value = aws_cloudfront_distribution.web.domain_name
    note  = "Create this at your DNS provider, pointing at the CloudFront hostname. For an apex domain use your provider's ALIAS/ANAME/CNAME-flattening equivalent."
  } : null
}

# Ready-to-copy contents for functions/api/.env.local and functions/indexer/.env.local.
# Contains only names/ARNs, no secrets.
output "env_local" {
  description = "Paste into functions/api/.env.local and functions/indexer/.env.local for local development."
  value       = <<-EOT
    AWS_REGION=${var.region}
    VECTOR_BUCKET=${aws_s3vectors_vector_bucket.this.vector_bucket_name}
    VECTOR_INDEX=${aws_s3vectors_index.pages.index_name}
    BEDROCK_MODEL_ID=${var.bedrock_model_id}
    CHAT_MODEL_ID=${var.chat_model_id}
    SITE_URL=${var.site_url}
    GUARDRAIL_ID=${aws_bedrock_guardrail.this.guardrail_id}
    GUARDRAIL_VERSION=${aws_bedrock_guardrail.this.version}
    USAGE_TABLE=${aws_dynamodb_table.usage.name}
    DAILY_BUDGET_USD=${var.daily_budget_usd}
    IP_DAILY_LIMIT=${var.ip_daily_message_limit}
    MAX_INPUT_TOKENS=${var.max_input_tokens}
  EOT
}
