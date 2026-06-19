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
STACK="${STACK:-cog-stac-read}"
S1M_STACK="${S1M_STACK:-cog-stac-s1m}"
FOUNDATION_STACK="${FOUNDATION_STACK:-cog-stac-foundation}"
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
S1M_API_BASE="${S1M_API_BASE:-$(aws cloudformation describe-stacks \
  --stack-name "$S1M_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='S1MApiUrl'].OutputValue" \
  --output text 2>/dev/null || true)}"
S1M_DEMO_TOKEN="${S1M_DEMO_TOKEN:-$(aws lambda get-function-configuration \
  --function-name cog-stac-s1m --region "$REGION" \
  --query 'Environment.Variables.S1M_DEMO_TOKEN' --output text 2>/dev/null || true)}"
BUCKET="${BUCKET:-$(get_out ViewerBucketName)}"
VIEWER_URL="${VIEWER_URL:-$(get_out ViewerUrl)}"
if [ -z "$API_BASE" ] || [ "$API_BASE" = "None" ] || [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "ERROR: stack '$STACK' outputs not found -- deploy the stack first (sam deploy)." >&2
  exit 1
fi
API_BASE="${API_BASE%/}"
S1M_API_BASE="${S1M_API_BASE%/}"
if [ -z "$S1M_API_BASE" ] || [ "$S1M_API_BASE" = "None" ]; then
  echo "ERROR: S1MApiUrl was not found in stack '$S1M_STACK'." >&2
  echo "       Deploy it with ./deploy-s1m.sh or pass S1M_API_BASE explicitly." >&2
  exit 1
fi
if [ -z "$S1M_DEMO_TOKEN" ] || [ "$S1M_DEMO_TOKEN" = "None" ]; then
  echo "ERROR: S1M_DEMO_TOKEN was not found on function 'cog-stac-s1m'." >&2
  echo "       Deploy S1M first or pass S1M_DEMO_TOKEN explicitly." >&2
  exit 1
fi

# Public-tile CloudFront proxy base + distribution id come from the foundation
# stack. TILE_BASE (if resolved/overridden) is baked into the viewer config below
# so public-collection COG tiles route through CloudFront (CORS + cache). DIST_ID
# is used only for the opt-in cache invalidation at the end.
TILE_BASE="${TILE_BASE:-$(get_foundation_out TileBase)}"
DIST_ID="${DIST_ID:-$(get_foundation_out DistributionId)}"
[ "$TILE_BASE" = "None" ] && TILE_BASE=""
[ "$DIST_ID" = "None" ] && DIST_ID=""
if [ -z "$TILE_BASE" ]; then
  echo "ERROR: CloudFront TileBase was not found in foundation stack '$FOUNDATION_STACK'." >&2
  echo "       Refusing to publish without the required public COG tile proxy." >&2
  echo "       Deploy the foundation stack or pass TILE_BASE explicitly, for example:" >&2
  echo "       TILE_BASE=https://d3otm97s6tpvta.cloudfront.net $0" >&2
  exit 1
fi

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
printf 'window.S3_COG_API_BASE = "%s";\n' "$API_BASE" > "$STAGE/config.js"
printf 'window.S3_COG_S1M_API_BASE = "%s";\n' "$S1M_API_BASE" >> "$STAGE/config.js"
printf 'window.S3_COG_S1M_DEMO_TOKEN = "%s";\n' "$S1M_DEMO_TOKEN" >> "$STAGE/config.js"
# CloudFront tile proxy base. Public-collection COG tiles require this for CORS
# and range-read caching; the preflight above prevents publishing without it.
printf 'window.S3_COG_TILE_BASE = "%s";\n' "$TILE_BASE" >> "$STAGE/config.js"
echo "  TILE_BASE      : $TILE_BASE"

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

# Opt-in CloudFront invalidation. The VIEWER is served straight from the S3
# website endpoint (not fronted by CloudFront), so a viewer republish needs no
# invalidation. The foundation CloudFront only proxies PUBLIC SOURCE COG tiles --
# invalidate it when that source data changes, via INVALIDATE_TILES=1. Requires
# the deploy role's scoped cloudfront:CreateInvalidation.
if [ "${INVALIDATE_TILES:-0}" = "1" ]; then
  if [ -n "$DIST_ID" ]; then
    echo "Invalidating CloudFront tile cache (distribution $DIST_ID)…"
    aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
      --paths '/*' --query 'Invalidation.Id' --output text
  else
    echo "WARN: INVALIDATE_TILES=1 but no DistributionId (foundation stack '$FOUNDATION_STACK' missing?) -- skipping." >&2
  fi
fi

echo
echo "Published viewer -> $VIEWER_URL"
echo "  API base       : $API_BASE"
[ -n "$S1M_API_BASE" ] && echo "  S1M API base   : $S1M_API_BASE"
echo "  bucket         : s3://$BUCKET"
[ -n "$TILE_BASE" ] && echo "  tile base      : $TILE_BASE"
