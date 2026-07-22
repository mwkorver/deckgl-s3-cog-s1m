#!/usr/bin/env bash
#
# Publish the static viewer to its S3 website bucket.
#
# The viewer (api/viewer) is pure HTML/JS; it calls the API cross-origin via
# window.S3_COG_API_BASE. This script:
#   1. reads the read-API URL + viewer bucket from the deployed stack outputs,
#   2. stages api/viewer + a generated config.js (sets window.S3_COG_API_BASE),
#   3. stages the built @developmentseed JS packages under /local-modules/<name>/
#      (the importmap in index.html resolves those paths against the S3 origin),
#   4. `aws s3 sync --delete` the staging dir to the bucket.
#
# Updating the viewer is then just: edit -> ./deploy-viewer.sh -> refresh.
# Requires the stack to be deployed first (sam deploy) and the JS packages
# built (`pnpm build` at the repo root).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="${STACK:-deckgl-s3-cog-s1m-read}"
FOUNDATION_STACK="${FOUNDATION_STACK:-deckgl-s3-cog-s1m-foundation}"
REGION="${REGION:-us-west-2}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VIEWER_DIR="$SCRIPT_DIR/../viewer"
PKG_DIR="$REPO_ROOT/packages"
MODULES=(affine deck.gl-geotiff deck.gl-raster geotiff morecantile proj raster-reproject)

get_out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
# Foundation stack outputs (viewer bucket + CloudFront tile proxy live there).
get_foundation_out() {
  aws cloudformation describe-stacks --stack-name "$FOUNDATION_STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

API_BASE="$(get_out ApiUrl)"
BUCKET="${BUCKET:-$(get_out ViewerBucketName)}"
VIEWER_URL="${VIEWER_URL:-$(get_out ViewerUrl)}"
if [ -z "$API_BASE" ] || [ "$API_BASE" = "None" ] || [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "ERROR: stack '$STACK' outputs not found -- deploy the stack first (sam deploy)." >&2
  exit 1
fi
API_BASE="${API_BASE%/}"

# CloudFront was removed: the viewer reads public-collection COGs directly from
# their source buckets (which must serve CORS), so there is no tile proxy base
# or distribution to resolve here.

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 0. Recompile collections.geojson (the map "what's here" lookup) from the
# curated registry, so editing registry.yaml then forgetting to rebuild can't
# ship a stale lookup. Best-effort: fall back to the existing file if the venv
# or compiler is missing.
COMPILE_PY="$SCRIPT_DIR/../.venv/bin/python"
COMPILE_SCRIPT="$SCRIPT_DIR/../collections/build_collections_geojson.py"
if [ -x "$COMPILE_PY" ] && [ -f "$COMPILE_SCRIPT" ]; then
  "$COMPILE_PY" "$COMPILE_SCRIPT" || echo "WARN: collections.geojson compile failed; shipping existing copy." >&2
else
  echo "WARN: venv/compiler missing; shipping existing api/viewer/collections.geojson." >&2
fi

# 1. Viewer files + generated API base config.
cp -R "$VIEWER_DIR/." "$STAGE/"
find "$STAGE" -name ".DS_Store" -type f -delete
find "$STAGE" -name "__pycache__" -type d -prune -exec rm -rf {} +
find "$STAGE" -name "*.pyc" -type f -delete
# NOTE: the ingest token is deliberately NOT written here. This bucket is a
# public website origin, so anything in config.js is world-readable -- baking the
# token in published the key to the write endpoints. The viewer now prompts for
# it per session (see the "Ingest token" field in the ingest panel); retrieve it
# with the SSM command deploy-ingest.sh prints.
python3 - "$STAGE/config.js" "$API_BASE" <<'PY'
import json
import sys

path, api_base = sys.argv[1:3]
with open(path, "w", encoding="utf-8") as f:
    f.write(f"window.S3_COG_API_BASE = {json.dumps(api_base)};\n")
PY

# 2. Built JS packages -> /local-modules/<name>/ (matches the importmap paths).
mkdir -p "$STAGE/local-modules"
for name in "${MODULES[@]}"; do
  dist="$PKG_DIR/$name/dist"
  if [ ! -d "$dist" ]; then
    echo "ERROR: $dist missing -- run 'pnpm build' at the repo root first." >&2
    exit 1
  fi
  mkdir -p "$STAGE/local-modules/$name"
  cp -R "$dist/." "$STAGE/local-modules/$name/"
done

# 3. Publish (remove stale VIEWER objects with --delete).
# CRITICAL: this bucket also holds the app's PRIVATE output (lake/ footprints).
# --delete removes anything in the bucket NOT in the viewer
# staging dir, so WITHOUT these excludes it wipes the lake on every republish
# (it did, once). Excluding those prefixes protects them from the delete sweep.
aws s3 sync "$STAGE" "s3://$BUCKET/" --delete --region "$REGION" \
  --exclude "lake/*"

# The module URLs are intentionally stable. Force browsers to revalidate them so
# a renderer update cannot leave an older WebGL/COG implementation cached.
aws s3 cp "$STAGE/local-modules/" "s3://$BUCKET/local-modules/" \
  --recursive --region "$REGION" \
  --cache-control "no-cache, no-store, must-revalidate"

# app.js is the viewer application itself, on an equally stable URL. It used to
# be inlined in index.html and so could never go stale independently; now that it
# is a separate cacheable asset it needs the same revalidation, or a browser can
# pair a fresh index.html with a cached older app.
aws s3 cp "$STAGE/app.js" "s3://$BUCKET/app.js" \
  --region "$REGION" \
  --content-type "text/javascript" \
  --cache-control "no-cache, no-store, must-revalidate"

# (CloudFront removed -- the viewer is served straight from the S3 website
# endpoint and public COGs are read directly, so there is no tile cache to
# invalidate.)

echo
echo "Published viewer -> $VIEWER_URL"
echo "  API base       : $API_BASE"
echo "  bucket         : s3://$BUCKET"
if [ -n "${TILE_BASE:-}" ]; then
  echo "  tile base      : $TILE_BASE"
fi
