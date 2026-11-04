resource "aws_s3_bucket" "ingest" {
  bucket = "${var.name}-ingest-${var.sandbox_account_id}"
  # Holds only public source files that load-graph can fetch again, and the tool schema.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "ingest" {
  bucket                  = aws_s3_bucket.ingest.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
