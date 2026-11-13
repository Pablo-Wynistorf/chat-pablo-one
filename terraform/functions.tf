# Lambda functions, one per folder under functions/:
#
#   functions/api      -> aws_lambda_function.api      (HTTP API behind API Gateway)
#   functions/indexer  -> aws_lambda_function.indexer  (EventBridge schedule)
#
# TERRAFORGE OWNERSHIP: Terraform owns everything about these functions EXCEPT
# the code: runtime, handler, memory, timeout, IAM role and environment. It
# deploys a tiny placeholder zip so each function (and its published version and
# "live" alias) can exist on the first apply. TerraForge builds the folder, uploads
# the zip, publishes a version and moves the "live" alias to it. Everything that
# invokes a function points at the alias, never at the bare function or $LATEST.
#
# Both buildspecs emit dist/index.mjs (an esbuild ESM bundle), hence
# handler = "index.handler" on nodejs22.x / arm64 (no native dependencies).

# Replaced by TerraForge on the first function deploy; see ignore_changes below.
data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/.placeholder/lambda.zip"

  source {
    filename = "index.js"
    content  = "exports.handler = async () => ({ statusCode: 503, body: 'Not deployed yet' });"
  }
}

# =============================================================================
# api
# =============================================================================

resource "aws_iam_role" "api" {
  name               = "${var.project_name}-api"
  description        = "Execution role for the chatbot API Lambda (functions/api)."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api" {
  name   = "${var.project_name}-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project_name}-api"
  retention_in_days = local.log_retention_days
}

resource "aws_lambda_function" "api" {
  function_name = "${var.project_name}-api"
  description   = "RAG chatbot API (/api/chat, /api/greeting, /api/search) behind API Gateway and CloudFront."
  role          = aws_iam_role.api.arn
  package_type  = "Zip"

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256
  publish          = true

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = local.api_lambda_memory
  timeout       = local.api_lambda_timeout

  environment {
    variables = {
      NODE_ENV = "production"
      # AWS_REGION is injected by the Lambda runtime (reserved key). No
      # AWS_ROLE_ARN: the code runs directly as this function's execution role.
      VECTOR_BUCKET     = aws_s3vectors_vector_bucket.this.vector_bucket_name
      VECTOR_INDEX      = aws_s3vectors_index.pages.index_name
      BEDROCK_MODEL_ID  = var.bedrock_model_id
      CHAT_MODEL_ID     = var.chat_model_id
      SITE_URL          = var.site_url
      GUARDRAIL_ID      = aws_bedrock_guardrail.this.guardrail_id
      GUARDRAIL_VERSION = aws_bedrock_guardrail.this.version
      USAGE_TABLE       = aws_dynamodb_table.usage.name
      DAILY_BUDGET_USD  = tostring(local.daily_budget_usd)
      IP_DAILY_LIMIT    = tostring(local.ip_daily_message_limit)
      MAX_INPUT_TOKENS  = tostring(local.max_input_tokens)
    }
  }

  lifecycle {
    # Code is deployed by TerraForge, not Terraform. Environment changes reach
    # traffic only after the next TerraForge build is published.
    ignore_changes = [filename, source_code_hash, s3_bucket, s3_key, s3_object_version]
  }

  depends_on = [
    aws_iam_role_policy.api,
    aws_iam_role_policy_attachment.api_logs,
    aws_cloudwatch_log_group.api,
  ]
}

resource "aws_lambda_alias" "api_live" {
  name             = "live"
  description      = "Version served to traffic; moved by TerraForge on publish."
  function_name    = aws_lambda_function.api.function_name
  function_version = aws_lambda_function.api.version

  lifecycle {
    ignore_changes = [function_version]
  }
}

# =============================================================================
# indexer
# =============================================================================

resource "aws_iam_role" "indexer" {
  name               = "${var.project_name}-indexer"
  description        = "Execution role for the vector index sync Lambda (functions/indexer)."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "indexer_logs" {
  role       = aws_iam_role.indexer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "indexer" {
  name   = "${var.project_name}-indexer"
  role   = aws_iam_role.indexer.id
  policy = data.aws_iam_policy_document.indexer.json
}

resource "aws_cloudwatch_log_group" "indexer" {
  name              = "/aws/lambda/${var.project_name}-indexer"
  retention_in_days = local.log_retention_days
}

resource "aws_lambda_function" "indexer" {
  function_name = "${var.project_name}-indexer"
  description   = "Syncs the bundled data/*.json chunks into the S3 Vectors index (incremental, idempotent)."
  role          = aws_iam_role.indexer.arn
  package_type  = "Zip"

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256
  publish          = true

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = local.indexer_lambda_memory
  timeout       = local.indexer_lambda_timeout

  environment {
    variables = {
      VECTOR_BUCKET       = aws_s3vectors_vector_bucket.this.vector_bucket_name
      VECTOR_INDEX        = aws_s3vectors_index.pages.index_name
      BEDROCK_MODEL_ID    = var.bedrock_model_id
      INDEXER_SKIP_DOTENV = "1"
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash, s3_bucket, s3_key, s3_object_version]
  }

  depends_on = [
    aws_iam_role_policy.indexer,
    aws_iam_role_policy_attachment.indexer_logs,
    aws_cloudwatch_log_group.indexer,
  ]
}

resource "aws_lambda_alias" "indexer_live" {
  name             = "live"
  description      = "Version that runs on schedule; moved by TerraForge on publish."
  function_name    = aws_lambda_function.indexer.function_name
  function_version = aws_lambda_function.indexer.version

  lifecycle {
    ignore_changes = [function_version]
  }
}

# Schedule on the live alias, so only a published indexer version ever writes to
# the index. Disabled entirely when indexer_schedule is empty.
resource "aws_cloudwatch_event_rule" "indexer" {
  count               = var.indexer_schedule == "" ? 0 : 1
  name                = "${var.project_name}-indexer"
  description         = "Runs the indexer (live alias) to sync data/*.json into the vector index."
  schedule_expression = var.indexer_schedule
}

resource "aws_cloudwatch_event_target" "indexer" {
  count = var.indexer_schedule == "" ? 0 : 1
  rule  = aws_cloudwatch_event_rule.indexer[0].name
  arn   = aws_lambda_alias.indexer_live.arn
  input = jsonencode({})
}

resource "aws_lambda_permission" "indexer_schedule" {
  count         = var.indexer_schedule == "" ? 0 : 1
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.indexer.function_name
  qualifier     = aws_lambda_alias.indexer_live.name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.indexer[0].arn
}
