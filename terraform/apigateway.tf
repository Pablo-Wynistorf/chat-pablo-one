# API Gateway HTTP API fronting the web Lambda. A single $default route proxies
# every path/method to the function, so all Next.js routes (pages, /_next/static
# assets, and the /api/* handlers) are served through one integration.

resource "aws_apigatewayv2_api" "web" {
  name          = "${var.project_name}-web"
  description   = "HTTP API for the pablo.one Next.js chatbot."
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "web" {
  api_id           = aws_apigatewayv2_api.web.id
  integration_type = "AWS_PROXY"
  # The "live" alias, never the bare function/$LATEST: TerraForge deploys by
  # moving this alias, so API Gateway must invoke it to pick up new versions.
  integration_uri = aws_lambda_alias.web_live.invoke_arn
  # Lambda proxy integrations are always invoked with POST regardless of the
  # client's HTTP method (the real method is carried in the event).
  integration_method     = "POST"
  payload_format_version = "2.0"
  # HTTP APIs cap the integration timeout at 30s.
  timeout_milliseconds = 30000
}

resource "aws_apigatewayv2_route" "web_default" {
  api_id    = aws_apigatewayv2_api.web.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.web.id}"
}

# $default stage is served at the API root (no stage-name path prefix), so the
# app's relative fetches (/api/chat, /_next/...) resolve correctly.
resource "aws_apigatewayv2_stage" "web" {
  api_id      = aws_apigatewayv2_api.web.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 50
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.web.function_name
  # Grant invoke on the alias specifically (qualified permission), matching the
  # integration above.
  qualifier  = aws_lambda_alias.web_live.name
  principal  = "apigateway.amazonaws.com"
  source_arn = "${aws_apigatewayv2_api.web.execution_arn}/*/*"
}
