# Random suffix so repeated applies (or parallel demos) don't collide on the
# globally-scoped vector bucket name.
resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  bucket_name = "${var.project_name}-${random_id.suffix.hex}"
}

# The vector bucket: a specialized S3 bucket for storing/querying vector data.
resource "aws_s3vectors_vector_bucket" "this" {
  vector_bucket_name = local.bucket_name

  # Allow `terraform destroy` to remove the bucket even though it still holds
  # indexes and vectors.
  force_destroy = true
}

# A single index holding one vector per page-chunk of the crawled website.
# Search is a plain topK nearest-neighbour lookup — no tenant filter needed.
resource "aws_s3vectors_index" "pages" {
  index_name         = var.index_name
  vector_bucket_name = aws_s3vectors_vector_bucket.this.vector_bucket_name

  data_type       = "float32"
  dimension       = var.vector_dimension
  distance_metric = var.distance_metric

  # title / text / description are returned with results but never filtered on.
  # url + section stay filterable (the default).
  metadata_configuration {
    non_filterable_metadata_keys = var.non_filterable_metadata_keys
  }
}
