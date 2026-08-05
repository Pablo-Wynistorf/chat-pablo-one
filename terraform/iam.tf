# The app's least-privilege data-plane policy: exactly this index + the specific
# Bedrock models + the guardrail + the usage table, and nothing else.
#
# Consumed by the web Lambda's execution role (see lambda.tf). Locally, the
# indexer and dev server just run as whatever identity you're logged into the
# account with, so there is no separate role to assume — hence no aws_iam_role
# here, only the policy document.
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

