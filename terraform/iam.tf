# Role that the indexer and Next.js API routes assume to get least-privilege,
# temporary credentials scoped to exactly this index + the one Bedrock model.
resource "aws_iam_role" "dev" {
  name        = "${var.project_name}-dev"
  description = "Local dev + indexer role for the pablo.one S3 Vectors website-search POC."

  # Trust policy: allow the account root to assume. This lets any principal in
  # the account (your local dev identity) run `sts:AssumeRole` for this POC.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountRootAssume"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

data "aws_iam_policy_document" "dev" {
  # Vector data-plane operations, scoped to the specific bucket + index ARNs.
  # NOTE: QueryVectors with returnMetadata=true also requires GetVectors.
  statement {
    sid    = "S3VectorsDataPlane"
    effect = "Allow"
    actions = [
      "s3vectors:PutVectors",
      "s3vectors:QueryVectors",
      "s3vectors:GetVectors",
      "s3vectors:DeleteVectors",
      "s3vectors:ListVectors",
    ]
    resources = [
      aws_s3vectors_vector_bucket.this.vector_bucket_arn,
      aws_s3vectors_index.pages.index_arn,
    ]
  }

  # Bedrock embeddings, scoped to just the Titan Embed Text v2 model.
  statement {
    sid    = "BedrockEmbed"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
    ]
    resources = [
      "arn:aws:bedrock:${var.region}::foundation-model/${var.bedrock_model_id}",
    ]
  }

  # Bedrock text generation for the RAG chatbot (Converse + streaming).
  # The chat model is a cross-region inference profile, so we must allow both
  # the inference-profile resource and the underlying foundation model in every
  # region the profile can route to (hence the region wildcard on the model).
  statement {
    sid    = "BedrockChat"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.chat_model_id}",
      "arn:aws:bedrock:*::foundation-model/${replace(var.chat_model_id, "/^[a-z]+\\./", "")}",
    ]
  }

  # Apply the guardrail during Converse calls.
  statement {
    sid       = "BedrockGuardrail"
    effect    = "Allow"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = [aws_bedrock_guardrail.this.guardrail_arn]
  }

  # Usage tracking: daily cost budget + per-IP message counters.
  statement {
    sid    = "DynamoUsage"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.usage.arn]
  }
}

resource "aws_iam_role_policy" "dev" {
  name   = "${var.project_name}-dev-policy"
  role   = aws_iam_role.dev.id
  policy = data.aws_iam_policy_document.dev.json
}
