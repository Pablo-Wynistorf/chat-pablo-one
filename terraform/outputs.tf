output "region" {
  description = "AWS region everything was created in."
  value       = var.region
}

output "vector_bucket_name" {
  description = "Name of the S3 vector bucket."
  value       = aws_s3vectors_vector_bucket.this.vector_bucket_name
}

output "vector_bucket_arn" {
  description = "ARN of the S3 vector bucket."
  value       = aws_s3vectors_vector_bucket.this.vector_bucket_arn
}

output "index_name" {
  description = "Name of the vector index."
  value       = aws_s3vectors_index.pages.index_name
}

output "index_arn" {
  description = "ARN of the vector index."
  value       = aws_s3vectors_index.pages.index_arn
}

output "bedrock_model_id" {
  description = "Bedrock embedding model id."
  value       = var.bedrock_model_id
}

output "chat_model_id" {
  description = "Bedrock chat model id (inference profile) used by the RAG chatbot."
  value       = var.chat_model_id
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
  description = "DynamoDB table tracking daily cost + per-IP message counts."
  value       = aws_dynamodb_table.usage.name
}

output "web_url" {
  description = "Public URL of the deployed chatbot — the custom domain when configured, otherwise the CloudFront hostname."
  value       = local.custom_domain_enabled ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "cloudfront_domain_name" {
  description = "Generated CloudFront hostname. Always works, even with a custom domain attached — useful for debugging DNS."
  value       = aws_cloudfront_distribution.web.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID, for manual cache invalidations."
  value       = aws_cloudfront_distribution.web.id
}

output "frontend_bucket" {
  description = "S3 bucket holding the built frontend. Private — readable only by this distribution."
  value       = aws_s3_bucket.frontend.id
}

output "frontend_objects" {
  description = "Number of frontend files uploaded to S3 by Terraform."
  value       = module.frontend_files.object_count
}

output "api_gateway_url" {
  description = "API Gateway invoke URL. The CloudFront /api/* behaviour points here; hitting it directly bypasses the CDN and the edge geo headers."
  value       = aws_apigatewayv2_stage.web.invoke_url
}

# The DNS record to create by hand. Terraform can only manage this automatically
# for Route 53 zones; for any other DNS provider (Cloudflare, etc.) this output is
# the one manual step in the deploy.
output "dns_record" {
  description = "DNS record to create for the custom domain. Null when no custom domain is configured, or when Terraform already created it in Route 53."
  value = local.custom_domain_enabled && var.route53_zone_id == "" ? {
    type  = "CNAME"
    name  = var.domain_name
    value = aws_cloudfront_distribution.web.domain_name
    note  = "Create this at your DNS provider, pointing at the CloudFront hostname. If ${var.domain_name} is an apex/root domain, CNAME is invalid there — use your provider's ALIAS/ANAME/CNAME-flattening equivalent (Cloudflare's CNAME flattening works)."
  } : null
}

# Which corpus Terraform believes is loaded. The per-chunk record of what is
# actually indexed lives in the vectors' own `contentHash` metadata — see
# indexer.tf for why the index, not Terraform, is the source of truth.
output "indexed_corpus" {
  description = "Content hashes of the data files currently loaded into the vector index."
  value = {
    corpus_hash = terraform_data.vector_index_load.output.corpus_hash
    files       = terraform_data.vector_index_load.output.files
    embed_model = terraform_data.vector_index_load.output.embed_model
  }
}

output "web_lambda_name" {
  description = "Name of the Next.js web Lambda function."
  value       = aws_lambda_function.web.function_name
}

# Ready-to-copy contents for web/.env.local (the indexer reads the same vars).
# Contains only ARNs/names — no secrets — so it is safe to print.
output "env_local" {
  description = "Paste into web/.env.local (see README.md)."
  # No AWS_ROLE_ARN: locally the indexer/dev server use your logged-in account
  # credentials directly (indexer/lib/aws.ts only assumes a role when the var is
  # set). On Lambda the app runs as its own execution role.
  value = <<-EOT
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
