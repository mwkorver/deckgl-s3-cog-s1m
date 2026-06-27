#!/usr/bin/env bash
#
# Download the public USGS GeoPackage, convert it to Parquet, and publish it to
# the private per-account viewer bucket consumed by the S1M terrain path.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-west-2}"
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUCKET="${BUCKET:-deckgl-s3-cog-s1m-${ACCOUNT_ID}-us-west2}"
SOURCE="s3://prd-tnm/StagedProducts/Elevation/S1M/FullExtentSpatialMetadata/S1M_Products.gpkg"
DESTINATION="s3://${BUCKET}/lake/s1m/S1M_Products.parquet"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

aws s3 cp "$SOURCE" "$WORK_DIR/S1M_Products.gpkg" \
  --no-sign-request --region "$REGION"
python3 "$SCRIPT_DIR/../api/build_s1m_index.py" \
  "$WORK_DIR/S1M_Products.gpkg" "$WORK_DIR/S1M_Products.parquet"
aws s3 cp "$WORK_DIR/S1M_Products.parquet" "$DESTINATION" \
  --region "$REGION" --only-show-errors

echo "Published S1M index: $DESTINATION"
