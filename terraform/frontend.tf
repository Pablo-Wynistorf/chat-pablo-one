# S3 bucket holding the built frontend. Private: reachable only through
# CloudFront, via an Origin Access Control signed request.

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

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Only this distribution may read the bucket.
#
# s3:ListBucket is granted alongside GetObject so a missing key returns 404
# rather than 403 — without it S3 hides the difference, and CloudFront would have
# to treat every 403 as "not found", including genuine 403s from the API origin.
data "aws_iam_policy_document" "frontend" {
  statement {
    sid    = "AllowCloudFrontRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions = ["s3:GetObject", "s3:ListBucket"]

    resources = [
      aws_s3_bucket.frontend.arn,
      "${aws_s3_bucket.frontend.arn}/*",
    ]

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

# Upload the built frontend as individually managed objects. See the module for
# why this isn't `aws s3 sync`.
module "frontend_files" {
  source = "./modules/s3-site-upload"

  bucket     = aws_s3_bucket.frontend.id
  source_dir = local.static_dir

  # Everything is served through CloudFront with a 60s TTL; matching the object
  # header keeps browser and edge behaviour consistent.
  cache_control = "public, max-age=${var.frontend_cache_ttl}"

  depends_on = [
    aws_s3_bucket_ownership_controls.frontend,
    aws_s3_bucket_public_access_block.frontend,
  ]
}

# A new build means index.html changed under the same key, so the edge copy has to
# go. Asset filenames are content-hashed and don't strictly need this, but a single
# wildcard invalidation is simpler than enumerating paths and the first 1,000
# invalidation paths per month are free.
resource "terraform_data" "frontend_invalidation" {
  triggers_replace = {
    content_hash = module.frontend_files.content_hash
  }

  provisioner "local-exec" {
    command = join(" ", [
      "aws cloudfront create-invalidation",
      "--distribution-id ${aws_cloudfront_distribution.web.id}",
      "--paths '/*'",
      "--region ${var.region}",
      "--no-cli-pager",
      "--output text",
    ])
  }
}
