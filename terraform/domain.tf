# Optional custom domain, attached to the CloudFront distribution.
#
# Leave domain_name/acm_certificate_arn empty and the app is served from the
# generated *.cloudfront.net hostname. Set both and it is additionally served from
# your own hostname over TLS.
#
# The certificate goes on CloudFront, so it must be issued in us-east-1 — see the
# precondition in cloudfront.tf. Nothing here touches API Gateway: it has no custom
# domain of its own and is only ever reached through the distribution.

locals {
  custom_domain_enabled = var.domain_name != "" && var.acm_certificate_arn != ""
}

# Always-evaluated guard. A precondition on a conditional resource would only fire
# when that resource is being created, so "cert set but domain forgotten" would
# silently deploy without a domain and no warning.
resource "terraform_data" "domain_guard" {
  input = "${var.domain_name}|${var.acm_certificate_arn}"

  lifecycle {
    precondition {
      condition     = (var.domain_name == "") == (var.acm_certificate_arn == "")
      error_message = "Set both domain_name and acm_certificate_arn, or neither. Got domain_name=${var.domain_name == "" ? "(empty)" : var.domain_name}, acm_certificate_arn=${var.acm_certificate_arn == "" ? "(empty)" : "set"}."
    }
  }
}

# Optional DNS, Route 53 only. When the zone lives elsewhere (Cloudflare, etc.)
# leave route53_zone_id empty: Terraform has no provider credentials for that DNS,
# so creating the record is the one manual step. `terraform output dns_record`
# prints exactly what to add.
resource "aws_route53_record" "web" {
  for_each = local.custom_domain_enabled && var.route53_zone_id != "" ? toset(["A", "AAAA"]) : toset([])

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = each.value

  alias {
    name    = aws_cloudfront_distribution.web.domain_name
    zone_id = aws_cloudfront_distribution.web.hosted_zone_id
    # CloudFront has no health checks to evaluate.
    evaluate_target_health = false
  }
}
