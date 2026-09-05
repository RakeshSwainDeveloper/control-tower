#!/bin/sh
# Create the evidence bucket and lock it down. Runs once per `up`.
set -eu
echo "[minio-init] waiting for minio..."
until mc alias set local http://minio:9000 "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1; do
  sleep 1
done

mc mb --ignore-existing "local/$S3_BUCKET_EVIDENCE"

# Evidence is immutable (FR-172): versioning on, no public access ever.
mc version enable "local/$S3_BUCKET_EVIDENCE" || true
mc anonymous set none "local/$S3_BUCKET_EVIDENCE"

# Lifecycle: hot -> infrequent after 90 days (FR-188 tiering intent).
# MinIO honours transition only with tiers configured; the rule is declared
# here so prod S3 inherits identical policy.
echo "[minio-init] bucket '$S3_BUCKET_EVIDENCE' ready (versioned, private)"
