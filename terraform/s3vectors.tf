# Random suffix so repeated applies (or parallel demos) don't collide on the
# globally-scoped vector bucket name. Also used by the frontend bucket name.
resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  bucket_name = "${var.project_name}-${random_id.suffix.hex}"
}

# DATA THAT MUST SURVIVE A DESTROY
#
# The vector bucket and its index are the only resources in this stack that are
# slow to rebuild (a full re-embed of the corpus), so both carry prevent_destroy.
# Consequences:
#   - Any change that would replace the index (index_name, vector_dimension,
#     distance_metric, non_filterable_metadata_keys) fails at plan time instead of
#     silently wiping the vectors.
#   - A full `terraform destroy` stops with an error on these two resources.
#     To tear down the rest of the stack and keep the index, see AGENTS.md
#     ("Destroying the stack").
resource "aws_s3vectors_vector_bucket" "this" {
  vector_bucket_name = local.bucket_name

  # Never delete the bucket while it still holds the index.
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

# A single index holding one vector per page-chunk of the crawled website.
# Search is a plain topK nearest-neighbour lookup — no tenant filter needed.
resource "aws_s3vectors_index" "pages" {
  index_name         = var.index_name
  vector_bucket_name = aws_s3vectors_vector_bucket.this.vector_bucket_name

  data_type       = "float32"
  dimension       = local.vector_dimension
  distance_metric = var.distance_metric

  # title / text / description are returned with results but never filtered on.
  # url + section stay filterable (the default).
  metadata_configuration {
    non_filterable_metadata_keys = local.non_filterable_metadata_keys
  }

  lifecycle {
    prevent_destroy = true
  }
}
