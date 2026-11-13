# API Gateway HTTP API in front of the api function's "live" alias. CloudFront
# routes /api/* here (cloudfront.tf). One route per API endpoint, all on the same
# integration; the function does its own routing (functions/api/src/app.ts).
#
# The routes are deliberately public (no authorizer): it is an anonymous chat
# widget. Abuse is bounded by the stage throttling below and the per-IP and daily
# budget limits the function enforces with the usage table.
#
# DO NOT let this API be replaced. CloudFront's origins are under
# ignore_changes (TerraForge owns origin_path), so a new API id would leave the
# distribution pointing at a deleted API.

resource "aws_apigatewayv2_api" "api" {
  name          = "${var.project_name}-api"
  description   = "HTTP API for the pablo.one chatbot."
  protocol_type = "HTTP"

  # API Gateway answers OPTIONS preflights itself (no Lambda call) and adds the
  # CORS headers to every response. CloudFront's /api/* behaviour allows OPTIONS
  # and forwards the Origin header.
  cors_configuration {
    allow_origins = local.cors_allowed_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type"]
    # Read by the page from /api/greeting and /api/chat responses.
    expose_headers = ["x-visitor", "x-sources"]
    max_age        = 600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id           = aws_apigatewayv2_api.api.id
  integration_type = "AWS_PROXY"
  # The "live" alias, never the bare function or $LATEST.
  integration_uri = aws_lambda_alias.api_live.invoke_arn
  # Lambda proxy integrations are always invoked with POST.
  integration_method     = "POST"
  payload_format_version = "2.0"
  # HTTP APIs cap the integration timeout at 30s.
  timeout_milliseconds = 30000
}

# Explicit routes, no $default catch-all. A $default route also matches OPTIONS,
# which would send CORS preflights to the Lambda (405). With no OPTIONS route,
# API Gateway answers preflights itself from cors_configuration above.
# Keep in sync with ROUTES in functions/api/src/app.ts.
locals {
  api_routes = toset([
    "POST /api/chat",
    "GET /api/greeting",
    "POST /api/search",
  ])
}

resource "aws_apigatewayv2_route" "api" {
  for_each  = local.api_routes
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# $default stage is served at the API root (no stage-name path prefix), so
# /api/chat etc. resolve unchanged.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 50
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  qualifier     = aws_lambda_alias.api_live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
