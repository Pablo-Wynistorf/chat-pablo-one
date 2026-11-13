# S3 bucket for the "web" frontend (frontends/web). Private: reachable only
# through CloudFront, via an Origin Access Control signed request.
#
# TERRAFORGE OWNERSHIP: Terraform creates ONLY the bucket and its config here.
# It never manages site objects (no aws_s3_object). TerraForge uploads each build
# to s3://<bucket>/versions/<version_id>/... with the account admin role and then
# activates a version by switching the CloudFront origin_path (see cloudfront.tf).
#
# The bucket name keeps its original random suffix on purpose: renaming it would
# replace the bucket, and CloudFront would keep pointing at the old one because
# its origins are under ignore_changes.

resource "aws_s3_bucket" "web" {
  bucket        = "${var.project_name}-frontend-${random_id.suffix.hex}"
  force_destroy = true # only build output lives here
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# TerraForge stores every build under its own versions/<id>/ prefix and activates
# by origin path, so object versioning is not required for rollback. Kept enabled
# as a safety net against accidental overwrite/delete of a published version.
resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Only this distribution may read the bucket, GetObject only. A missing key
# therefore answers 403 (not 404); CloudFront maps both to the 404 page.
data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid    = "AllowCloudFrontRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json
}
