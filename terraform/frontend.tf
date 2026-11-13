# S3 bucket holding the built frontend. Private: reachable only through
# CloudFront, via an Origin Access Control signed request.
#
# TERRAFORGE OWNERSHIP: Terraform creates ONLY the bucket and its config here.
# It never manages site objects (no aws_s3_object). TerraForge uploads each build
# to s3://<bucket>/versions/<version_id>/... with the account admin role and then
# activates a version by switching the CloudFront origin_path (see cloudfront.tf).

resource "aws_s3_bucket" "frontend" {
  bucket        = "${var.project_name}-frontend-${random_id.suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# TerraForge stores every build under its own versions/<id>/ prefix and activates
# by origin path, so object versioning is not required for rollback. Kept enabled
# as a safety net against accidental overwrite/delete of a published version.
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Only this distribution may read the bucket. GetObject only, scoped to the
# distribution ARN — the TerraForge-recommended OAC policy. A missing key
# therefore answers 403 (not 404); CloudFront maps both to the 404 page
# (see custom_error_response in cloudfront.tf).
data "aws_iam_policy_document" "frontend" {
  statement {
    sid    = "AllowCloudFrontRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend.json
}
