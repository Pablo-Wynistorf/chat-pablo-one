# Mirrors a local directory into an S3 bucket as individually managed objects.
#
# `aws s3 sync` in a provisioner would be fewer lines, but the objects would be
# invisible to Terraform: no drift detection, and nothing removes a file that
# disappears from the build. Managing them as resources means `terraform plan`
# shows exactly which assets change, and deleting a source file deletes the object.
#
# The trade-off is that for_each resolves at plan time, so source_dir must already
# exist when planning — which is why the caller builds via a data source rather
# than a provisioner.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.15.0"
    }
  }
}

locals {
  # "**" recurses, so nested paths like _next/static/chunks/app/page-abc.js are
  # included with their relative path intact — that path becomes the object key.
  files = fileset(var.source_dir, "**")

  objects = {
    for path in local.files : path => {
      extension = lower(try(element(reverse(split(".", basename(path))), 0), ""))
      source    = "${var.source_dir}/${path}"
    }
  }
}

resource "aws_s3_object" "this" {
  for_each = local.objects

  bucket = var.bucket
  key    = each.key
  source = each.value.source

  content_type  = lookup(var.content_types, each.value.extension, var.content_type_default)
  cache_control = var.cache_control

  # Content hash, so editing a file in place (same name) still re-uploads. Next.js
  # fingerprints most asset filenames, but index.html keeps its name forever.
  etag = filemd5(each.value.source)
}
