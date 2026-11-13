# Populate the vector index as part of `terraform apply`.
#
# Without this the apply leaves a correctly-configured but EMPTY index, and the
# chatbot answers every question with "I haven't put that on my site". The chunk
# files in indexer/data/ are committed, so this step only has to embed and load
# them — no crawling, no network beyond Bedrock and S3 Vectors.
#
# Two independent layers stop the same data being embedded twice:
#
#  1. Terraform (here) won't even run the loader unless something relevant
#     changed — the per-file hashes below are recorded in state, so `terraform
#     plan` can tell that data/*.json is byte-identical to what's already loaded.
#
#  2. The loader itself (indexer/embed_and_insert.ts) diffs each chunk's content
#     fingerprint against the `contentHash` metadata stored on the vectors in the
#     index, and embeds only what is new or edited. This is the authoritative
#     check, because it compares against the index rather than against local
#     bookkeeping that could be stale, missing, or from a different bucket.
#
# Layer 2 is what actually guarantees correctness; layer 1 just avoids spawning a
# no-op process on every apply. Editing one markdown file re-embeds that file's
# chunks and nothing else.

locals {
  indexer_dir  = "${path.module}/../indexer"
  indexer_data = "${local.indexer_dir}/data"

  # Per-file rather than one blob, so `terraform plan` names the file that changed
  # instead of just reporting that "something" did.
  corpus_file_hashes = {
    for f in fileset(local.indexer_data, "*.json") :
    f => filesha256("${local.indexer_data}/${f}")
  }

  # fileset() iterates in lexical order, so this is stable across runs.
  corpus_hash = sha256(join("", values(local.corpus_file_hashes)))

  # The loading logic itself: a change here can change what gets stored.
  loader_hash = sha256(join("", concat(
    [filesha256("${local.indexer_dir}/load-index.sh")],
    [filesha256("${local.indexer_dir}/embed_and_insert.ts")],
    [
      for f in fileset("${local.indexer_dir}/lib", "*.ts") :
      filesha256("${local.indexer_dir}/lib/${f}")
    ],
  )))
}

resource "terraform_data" "vector_index_load" {
  # Recorded in state, so `terraform state show terraform_data.vector_index_load`
  # answers "which corpus is currently in the index?" without touching AWS.
  input = {
    corpus_hash  = local.corpus_hash
    files        = local.corpus_file_hashes
    embed_model  = var.bedrock_model_id
    index_arn    = aws_s3vectors_index.pages.index_arn
    vector_index = aws_s3vectors_index.pages.index_name
  }

  # Re-run the loader when any of these change. A changed corpus_hash does NOT
  # mean the whole corpus is re-embedded — the loader still only writes the chunks
  # whose individual fingerprints moved.
  triggers_replace = {
    corpus_hash = local.corpus_hash
    loader_hash = local.loader_hash
    lockfile    = filesha256("${local.indexer_dir}/package-lock.json")
    # A different embedding model invalidates every stored vector. The loader
    # folds the model id into each chunk hash, so this is belt and braces.
    embed_model = var.bedrock_model_id
    # A replaced index is an empty index.
    index_arn = aws_s3vectors_index.pages.index_arn
  }

  provisioner "local-exec" {
    command     = "bash ./load-index.sh"
    working_dir = local.indexer_dir

    environment = {
      AWS_REGION       = var.region
      VECTOR_BUCKET    = aws_s3vectors_vector_bucket.this.vector_bucket_name
      VECTOR_INDEX     = aws_s3vectors_index.pages.index_name
      BEDROCK_MODEL_ID = var.bedrock_model_id
      # Ignore web/.env.local; use exactly what this apply created.
      INDEXER_SKIP_DOTENV = "1"
    }
  }

  depends_on = [aws_s3vectors_index.pages]
}
