# Usage-tracking table. Holds two kinds of items, keyed by `pk`:
#   cost#<YYYY-MM-DD>        -> { microUsd }  running spend for the day (micro-USD)
#   ip#<YYYY-MM-DD>#<ip>     -> { count }     messages from a public IP that day
# Both carry an `expiresAt` TTL so old counters self-clean. On-demand billing so
# the POC costs nothing when idle.
resource "aws_dynamodb_table" "usage" {
  name         = "${var.project_name}-usage"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
