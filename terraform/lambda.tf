# Next.js chatbot served from a single Lambda via the AWS Lambda Web Adapter,
# fronted by API Gateway (see apigateway.tf).

# The build and the zip both live in build.tf: they are shared with the S3
# frontend, and both have to resolve at plan time.

# --- Execution role -----------------------------------------------------------

resource "aws_iam_role" "web_lambda" {
  name        = "${var.project_name}-web-lambda"
  description = "Execution role for the pablo.one Next.js chatbot Lambda."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

# CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "web_lambda_basic" {
  role       = aws_iam_role.web_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Same least-privilege data-plane permissions the local dev role uses:
# S3 Vectors query + Bedrock embed/chat + guardrail + DynamoDB usage table.
# The app runs directly as this role on Lambda (no AWS_ROLE_ARN / AssumeRole).
resource "aws_iam_role_policy" "web_lambda" {
  name   = "${var.project_name}-web-lambda-policy"
  role   = aws_iam_role.web_lambda.id
  policy = data.aws_iam_policy_document.dev.json
}

# --- Function -----------------------------------------------------------------

resource "aws_cloudwatch_log_group" "web_lambda" {
  name              = "/aws/lambda/${var.project_name}-web"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "web" {
  function_name = "${var.project_name}-web"
  description   = "RAG chatbot API (/api/*) — Lambda Web Adapter behind API Gateway and CloudFront."
  role          = aws_iam_role.web_lambda.arn

  filename         = data.archive_file.web_lambda.output_path
  source_code_hash = data.archive_file.web_lambda.output_base64sha256

  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  handler       = "run.sh"
  memory_size   = var.web_lambda_memory
  timeout       = var.web_lambda_timeout

  # The Lambda Web Adapter layer provides /opt/bootstrap.
  layers = [var.lwa_layer_arn]

  environment {
    variables = {
      # --- Lambda Web Adapter ---
      # Make the adapter the entrypoint; it launches run.sh and proxies to :8080.
      AWS_LAMBDA_EXEC_WRAPPER = "/opt/bootstrap"
      PORT                    = "8080"
      NODE_ENV                = "production"

      # --- App config (mirrors web/.env.local) ---
      # NOTE: AWS_ROLE_ARN is intentionally omitted so the app uses THIS
      # function's execution role. AWS_REGION is injected by the Lambda runtime
      # and must not be set here (reserved key).
      VECTOR_BUCKET     = aws_s3vectors_vector_bucket.this.vector_bucket_name
      VECTOR_INDEX      = aws_s3vectors_index.pages.index_name
      BEDROCK_MODEL_ID  = var.bedrock_model_id
      CHAT_MODEL_ID     = var.chat_model_id
      SITE_URL          = var.site_url
      GUARDRAIL_ID      = aws_bedrock_guardrail.this.guardrail_id
      GUARDRAIL_VERSION = aws_bedrock_guardrail.this.version
      USAGE_TABLE       = aws_dynamodb_table.usage.name
      DAILY_BUDGET_USD  = tostring(var.daily_budget_usd)
      IP_DAILY_LIMIT    = tostring(var.ip_daily_message_limit)
      MAX_INPUT_TOKENS  = tostring(var.max_input_tokens)
    }
  }

  depends_on = [
    aws_iam_role_policy.web_lambda,
    aws_iam_role_policy_attachment.web_lambda_basic,
    aws_cloudwatch_log_group.web_lambda,
  ]
}
