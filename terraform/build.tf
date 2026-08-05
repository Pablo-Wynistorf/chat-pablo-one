# Builds the web app as part of Terraform, producing both deployment artifacts:
#
#   web/.static/  -> uploaded to S3, served through CloudFront (the frontend)
#   web/.lambda/  -> zipped and deployed as the API Lambda
#
# This is an `external` data source rather than a provisioner on purpose.
# `aws_s3_object.for_each` and `data.archive_file` are both resolved during PLAN,
# so the artifacts must exist by then. A `local-exec` provisioner only runs during
# apply, which is too late — on a fresh clone the upload module would enumerate an
# empty directory and deploy nothing. Data sources read at plan time, so this
# ordering holds and one `terraform apply` works from a clean checkout.
#
# It therefore runs on every plan. web/tf-build.sh keeps that cheap by stamping a
# hash of the inputs and skipping the build when nothing changed. Build output goes
# to stderr, which Terraform prints if the build fails.

data "external" "web_build" {
  program = ["bash", "${path.module}/../web/tf-build.sh"]

  query = {
    # Purely informational: makes the reason for a rebuild visible in the plan.
    project = var.project_name
  }
}

locals {
  static_dir = data.external.web_build.result.static_dir
  lambda_dir = data.external.web_build.result.lambda_dir
  build_hash = data.external.web_build.result.build_hash
}

# Zip the assembled Lambda directory. Depends on the build data source through
# local.lambda_dir, so no depends_on juggling is needed any more.
data "archive_file" "web_lambda" {
  type        = "zip"
  source_dir  = local.lambda_dir
  output_path = "${path.module}/build/lambda.zip"
}
