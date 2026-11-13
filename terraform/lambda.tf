# Next.js chatbot API served from a single Lambda via the AWS Lambda Web Adapter,
# fronted by API Gateway (see apigateway.tf) and CloudFront (/api/*).
#
# TERRAFORGE OWNERSHIP: Terraform owns everything about this function EXCEPT the
# code — runtime, handler, memory, timeout, IAM role, layers and environment. It
# deploys a tiny placeholder zip so the function (and its published version + the
# "live" alias) can exist on the first apply. TerraForge then builds
# functions/web, uploads the real zip, publishes a version and moves the "live"
# alias to it. Everything that invokes the function points at the alias, never at
# the unqualified function or $LATEST.

# --- Placeholder code ---------------------------------------------------------

# Replaced by TerraForge on the first function deploy; see ignore_changes below.
data "archive_file" "web_placeholder" {
  type        = "zip"
  output_path = "${path.module}/.placeholder/web.zip"

  source {
    filename = "index.js"
    content  = "exports.handler = async () => ({ statusCode: 503, body: 'Not deployed yet' });"
  }
}

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

# The shared least-privilege data-plane policy (data.aws_iam_policy_document.dev
# in iam.tf): S3 Vectors query + Bedrock embed/chat + guardrail + DynamoDB usage
# table. The app runs directly as this role on Lambda (no AWS_ROLE_ARN / AssumeRole).
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

  # Placeholder only; TerraForge replaces the code. ignore_changes keeps Terraform
  # from reverting a deployed version back to the placeholder on later applies.
  filename         = data.archive_file.web_placeholder.output_path
  source_code_hash = data.archive_file.web_placeholder.output_base64sha256

  # A numbered version for the "live" alias to point at.
  publish = true

  runtime       = "nodejs20.x"
  architectures = ["arm64"]
  # Generated into the artifact by functions/web/buildspec.yml; the real code
  # runs under the Lambda Web Adapter, which execs this handler.
  handler     = "run.sh"
  memory_size = var.web_lambda_memory
  timeout     = var.web_lambda_timeout

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

  lifecycle {
    # Code is deployed by TerraForge, not Terraform. A change to environment
    # variables above still applies on the next apply, but only reaches traffic
    # after the next TerraForge build is published and deployed.
    ignore_changes = [filename, source_code_hash, s3_bucket, s3_key, s3_object_version]
  }

  depends_on = [
    aws_iam_role_policy.web_lambda,
    aws_iam_role_policy_attachment.web_lambda_basic,
    aws_cloudwatch_log_group.web_lambda,
  ]
}

# The "live" alias is what API Gateway (and anything else) invokes. TerraForge
# moves it to each newly published version on deploy; Terraform must not move it
# back, hence ignore_changes on function_version. Created here (not by TerraForge)
# so the API Gateway permission can reference it on the first apply.
resource "aws_lambda_alias" "web_live" {
  name             = "live"
  description      = "Version served to traffic; moved by TerraForge on deploy."
  function_name    = aws_lambda_function.web.function_name
  function_version = aws_lambda_function.web.version

  lifecycle {
    ignore_changes = [function_version]
  }
}
