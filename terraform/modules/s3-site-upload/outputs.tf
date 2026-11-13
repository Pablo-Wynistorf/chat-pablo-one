output "object_count" {
  description = "Number of objects uploaded."
  value       = length(aws_s3_object.this)
}

output "keys" {
  description = "Object keys written to the bucket."
  value       = sort(keys(aws_s3_object.this))
}

output "content_hash" {
  description = "Combined hash of every uploaded object, for cache invalidation triggers."
  value       = sha256(join("", [for k in sort(keys(aws_s3_object.this)) : aws_s3_object.this[k].etag]))
}
