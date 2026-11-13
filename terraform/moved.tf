# State address renames from the pre-TerraForge layout, so existing resources are
# renamed in state instead of being destroyed and recreated. Safe to delete once
# every environment has applied them.
#
# Not listed on purpose: the old aws_lambda_function.web and its role, policy,
# log group, alias and API permission. The function is replaced by
# aws_lambda_function.api (new name, new runtime and handler), so those are
# destroyed and created fresh.

# --- frontend bucket (frontends/web) -----------------------------------------
moved {
  from = aws_s3_bucket.frontend
  to   = aws_s3_bucket.web
}

moved {
  from = aws_s3_bucket_public_access_block.frontend
  to   = aws_s3_bucket_public_access_block.web
}

moved {
  from = aws_s3_bucket_ownership_controls.frontend
  to   = aws_s3_bucket_ownership_controls.web
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.frontend
  to   = aws_s3_bucket_server_side_encryption_configuration.web
}

moved {
  from = aws_s3_bucket_versioning.frontend
  to   = aws_s3_bucket_versioning.web
}

moved {
  from = aws_s3_bucket_policy.frontend
  to   = aws_s3_bucket_policy.web
}

moved {
  from = aws_cloudfront_origin_access_control.frontend
  to   = aws_cloudfront_origin_access_control.web
}

# --- API Gateway (must never be replaced, see api.tf) ------------------------
moved {
  from = aws_apigatewayv2_api.web
  to   = aws_apigatewayv2_api.api
}

moved {
  from = aws_apigatewayv2_integration.web
  to   = aws_apigatewayv2_integration.api
}

moved {
  from = aws_apigatewayv2_stage.web
  to   = aws_apigatewayv2_stage.default
}
