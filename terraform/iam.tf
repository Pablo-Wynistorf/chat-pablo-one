# One execution role per function (roles themselves live in functions.tf), each
# with a policy scoped to exactly what that function's code calls.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- api ---------------------------------------------------------------------
# Calls: QueryVectors, InvokeModel (embed), ConverseStream (chat + guardrail),
# DynamoDB GetItem/UpdateItem on the usage table.
data "aws_iam_policy_document" "api" {
  # QueryVectors with returnMetadata=true also requires GetVectors.
  statement {
    sid       = "S3VectorsQuery"
    actions   = ["s3vectors:QueryVectors", "s3vectors:GetVectors"]
    resources = [aws_s3vectors_index.pages.index_arn]
  }

  statement {
    sid       = "BedrockEmbed"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${var.region}::foundation-model/${var.bedrock_model_id}"]
  }

  # The chat model is a cross-region inference profile, so both the profile and
  # the underlying foundation model in every region the profile can route to must
  # be allowed. The region wildcard on the model ARN is required for that.
  statement {
    sid = "BedrockChat"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.chat_model_id}",
      "arn:aws:bedrock:*::foundation-model/${replace(var.chat_model_id, "/^[a-z]+\\./", "")}",
    ]
  }

  statement {
    sid       = "BedrockGuardrail"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = [aws_bedrock_guardrail.this.guardrail_arn]
  }

  statement {
    sid       = "DynamoUsage"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.usage.arn]
  }
}

# --- indexer -----------------------------------------------------------------
# Calls: ListVectors (with metadata, hence GetVectors), PutVectors, DeleteVectors,
# InvokeModel (embed).
data "aws_iam_policy_document" "indexer" {
  statement {
    sid = "S3VectorsSync"
    actions = [
      "s3vectors:ListVectors",
      "s3vectors:GetVectors",
      "s3vectors:PutVectors",
      "s3vectors:DeleteVectors",
    ]
    resources = [aws_s3vectors_index.pages.index_arn]
  }

  statement {
    sid       = "BedrockEmbed"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:${var.region}::foundation-model/${var.bedrock_model_id}"]
  }
}
