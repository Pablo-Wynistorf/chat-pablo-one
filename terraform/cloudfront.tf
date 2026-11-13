# One CloudFront distribution fronting both origins:
#
#   default   -> S3 (the built frontend), cached for var.frontend_cache_ttl
#   /api/*    -> API Gateway (the Next.js API Lambda), never cached
#
# The TLS certificate lives here, so it must be in us-east-1 — a CloudFront
# requirement regardless of where the rest of the stack runs.

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-frontend-oac"
  description                       = "Signed access from CloudFront to the private frontend bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# --- Cache policies ----------------------------------------------------------

resource "aws_cloudfront_cache_policy" "frontend" {
  name        = "${var.project_name}-frontend"
  comment     = "Static frontend: short TTL, no request variation."
  min_ttl     = var.frontend_cache_ttl
  default_ttl = var.frontend_cache_ttl
  max_ttl     = var.frontend_cache_ttl

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    # Every asset is immutable-by-name or the single index.html, so nothing about
    # the request should split the cache.
    headers_config {
      header_behavior = "none"
    }
    cookies_config {
      cookie_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# The API must never be cached — answers are streamed, and the greeting is
# personalised per visitor. TTL 0 across the board, and nothing in the cache key.
#
# No CloudFront-Viewer-* geo headers here, despite lib/visitor.ts supporting them.
# They are only accepted in an *origin request* policy, and that policy is capped at
# 10 headers — not enough to also carry Content-Type, User-Agent, Accept-Language
# and the Client Hints. Breaking the JSON POST to save an IP lookup is a bad trade,
# so the origin request policy stays AllViewerExceptHostHeader (below) and geo comes
# from the ipinfo.io lookup, which is timeout-capped and cached per address.
resource "aws_cloudfront_cache_policy" "api" {
  name        = "${var.project_name}-api-nocache"
  comment     = "API: no caching, nothing in the cache key."
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    # Compression is negotiated per response; leave it off so streamed replies
    # aren't buffered while the edge compresses them.
    enable_accept_encoding_gzip   = false
    enable_accept_encoding_brotli = false

    headers_config {
      header_behavior = "none"
    }
    cookies_config {
      cookie_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# --- Response headers --------------------------------------------------------

# The document is now served from S3, which cannot return arbitrary headers, so
# `Accept-CH` has to be added at the edge instead.
#
# This matters: without it Chromium only sends the low-entropy Client Hints, and
# the personalised greeting loses the browser version, platform version, CPU
# architecture, device model and colour-scheme preference. next.config.mjs still
# sets the same header, but that only covers responses the Next server renders —
# which is now just /api/*.
resource "aws_cloudfront_response_headers_policy" "frontend" {
  name    = "${var.project_name}-frontend-headers"
  comment = "Client Hints opt-in plus baseline security headers."

  custom_headers_config {
    items {
      header   = "Accept-CH"
      override = true
      value = join(", ", [
        "Sec-CH-UA-Full-Version-List",
        "Sec-CH-UA-Platform",
        "Sec-CH-UA-Platform-Version",
        "Sec-CH-UA-Arch",
        "Sec-CH-UA-Bitness",
        "Sec-CH-UA-Model",
        "Sec-CH-UA-Mobile",
        "Sec-CH-Prefers-Color-Scheme",
        "Sec-CH-Prefers-Reduced-Motion",
        "Device-Memory",
        "DPR",
        "Save-Data",
        "Downlink",
        "RTT",
        "ECT",
      ])
    }
  }

  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }
  }
}

# --- Distribution ------------------------------------------------------------

locals {
  frontend_origin_id = "s3-frontend"
  api_origin_id      = "apigw-api"

  # AWS managed origin request policy "AllViewerExceptHostHeader". Forwards every
  # viewer header, cookie and query string EXCEPT Host — the exception matters,
  # since API Gateway routes on Host and rejects an unfamiliar one with a 403.
  managed_all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project_name} chatbot: S3 frontend + API Gateway API."
  default_root_object = "index.html"
  price_class         = var.cloudfront_price_class

  aliases = local.custom_domain_enabled ? [var.domain_name] : []

  origin {
    origin_id                = local.frontend_origin_id
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    origin_id = local.api_origin_id
    # The API Gateway invoke URL is https://<id>.execute-api.<region>.amazonaws.com
    # and CloudFront wants the bare host.
    domain_name = replace(replace(aws_apigatewayv2_stage.web.invoke_url, "https://", ""), "/", "")

    custom_origin_config {
      origin_protocol_policy = "https-only"
      http_port              = 80
      https_port             = 443
      origin_ssl_protocols   = ["TLSv1.2"]
      # Streamed answers can take a while to finish; keep the read timeout at the
      # API Gateway ceiling so CloudFront doesn't cut a reply short.
      origin_read_timeout = 30
    }
  }

  # Frontend.
  default_cache_behavior {
    target_origin_id           = local.frontend_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.frontend.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend.id
  }

  # API.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    # Off deliberately: compressing a streamed text/plain response makes the edge
    # buffer it, which would undo the token-by-token streaming.
    compress                 = false
    cache_policy_id          = aws_cloudfront_cache_policy.api.id
    origin_request_policy_id = local.managed_all_viewer_except_host
  }

  # The OAC bucket policy grants GetObject only, so S3 answers a missing key with
  # 403, not 404. Map both to the static 404 page. (Before the first frontend
  # version is activated the whole bucket 403s — the site returns the 404 page or
  # a bare CloudFront error until then, which is expected.)
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = var.frontend_cache_ttl
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = var.frontend_cache_ttl
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.custom_domain_enabled ? null : true
    acm_certificate_arn            = local.custom_domain_enabled ? var.acm_certificate_arn : null
    ssl_support_method             = local.custom_domain_enabled ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain_enabled ? "TLSv1.2_2021" : null
  }

  lifecycle {
    # TerraForge activates a frontend version by rewriting the S3 origin's
    # origin_path to /versions/<version_id>. Terraform must not fight that, so it
    # ignores all origin changes. CAVEAT: this also means later origin edits in
    # Terraform (including the API-Gateway origin's domain_name) are ignored — to
    # change an origin on purpose, remove this ignore temporarily and re-apply.
    ignore_changes = [origin]

    precondition {
      # CloudFront only accepts certificates from us-east-1, whatever region the
      # rest of the stack lives in. Checked here so the failure is a clear message
      # rather than an opaque InvalidViewerCertificate from the API.
      condition     = !local.custom_domain_enabled || split(":", var.acm_certificate_arn)[3] == "us-east-1"
      error_message = "acm_certificate_arn must be issued in us-east-1 for CloudFront, but it is in ${local.custom_domain_enabled ? split(":", var.acm_certificate_arn)[3] : "n/a"}. Re-issue the certificate in us-east-1 (the rest of the stack stays in ${var.region})."
    }
  }
}
