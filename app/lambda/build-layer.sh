#!/usr/bin/env bash
#
# Build a self-contained AWS Lambda layer for the COG STAC read API.
#
# The layer bundles, all version- and architecture-matched:
#   - the Python deps the read path needs (duckdb, fastapi, pydantic, mangum)
#   - the DuckDB `spatial`, `httpfs`, and `aws` extension binaries, baked under
#     /opt/duckdb_extensions so app.py LOADs them by path (no INSTALL, no
#     network egress, no writable $HOME required on cold start)
#
# boto3/botocore are intentionally omitted -- they ship in the Lambda runtime.
# pyproj/pyarrow/pillow are intentionally omitted -- they are ingest-only deps
# and app.py never imports them (ingest does not run on Lambda).
#
# Usage:
#   ./build-layer.sh                 # x86_64 (default)
#   ARCH=arm64 ./build-layer.sh      # arm64 / Graviton
#
# The DuckDB version MUST match the wheel; keep it in lockstep with
# api/requirements.txt (duckdb==<DUCKDB_VERSION>).
set -euo pipefail

DUCKDB_VERSION="${DUCKDB_VERSION:-1.5.3}"
ARCH="${ARCH:-x86_64}"
# Target the Lambda runtime's Python, NOT the host's -- pip resolves wheels by
# this version (the host here may be 3.14, Lambda is 3.12).
PY_VERSION="${PY_VERSION:-3.12}"

# Lambda Python 3.12/3.13 runtimes run on Amazon Linux 2023 (glibc 2.34), so we
# target the manylinux_2_28 wheels -- the older manylinux2014 (glibc 2.17) tag
# filters out every recent DuckDB build.
case "$ARCH" in
  x86_64)
    DUCKDB_PLATFORM="linux_amd64"
    PIP_PLATFORM="manylinux_2_28_x86_64"
    ;;
  arm64|aarch64)
    DUCKDB_PLATFORM="linux_arm64"
    PIP_PLATFORM="manylinux_2_28_aarch64"
    ;;
  *)
    echo "Unknown ARCH '$ARCH' (use x86_64 or arm64)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
LAYER_DIR="${BUILD_DIR}/layer"
OUT_ZIP="${SCRIPT_DIR}/duckdb-layer-${ARCH}.zip"
EXT_BASE="http://extensions.duckdb.org/v${DUCKDB_VERSION}/${DUCKDB_PLATFORM}"

echo ">> DuckDB v${DUCKDB_VERSION}  arch=${ARCH}  (duckdb=${DUCKDB_PLATFORM}, pip=${PIP_PLATFORM})"

rm -rf "$BUILD_DIR"
mkdir -p "${LAYER_DIR}/python" "${LAYER_DIR}/duckdb_extensions"

# 1. DuckDB extension binaries (served gzipped -> decompress to /opt path).
#    aws: provides the credential_chain secret provider used by enable_s3; baking
#    it avoids an INSTALL on cold start (no writable $HOME / network on Lambda).
for ext in spatial httpfs aws; do
  echo ">> fetching ${ext}.duckdb_extension"
  curl -fsSL "${EXT_BASE}/${ext}.duckdb_extension.gz" \
    | gunzip > "${LAYER_DIR}/duckdb_extensions/${ext}.duckdb_extension"
done

# 2. Python deps, built for the Lambda platform (NOT the host) so we get the
#    correct manylinux wheels rather than macOS/native builds.
echo ">> pip install read-path deps for ${PIP_PLATFORM}"
PIP="${PIP:-python3 -m pip}"
$PIP install \
  --platform "$PIP_PLATFORM" \
  --python-version "$PY_VERSION" \
  --implementation cp \
  --only-binary=:all: \
  --upgrade \
  --target "${LAYER_DIR}/python" \
  "duckdb==${DUCKDB_VERSION}" \
  fastapi \
  pydantic \
  mangum

# 3. Zip with the layer-required top-level layout (python/, plus our extras).
echo ">> zipping ${OUT_ZIP}"
rm -f "$OUT_ZIP"
( cd "$LAYER_DIR" && zip -q -r "$OUT_ZIP" python duckdb_extensions )

echo ">> done: ${OUT_ZIP}"
echo "   unzipped size:"
du -sh "$LAYER_DIR"
echo
echo "Publish with:"
echo "  aws lambda publish-layer-version \\"
echo "    --layer-name cog-stac-duckdb-${ARCH} \\"
echo "    --zip-file fileb://${OUT_ZIP##*/} \\"
echo "    --compatible-runtimes python3.12 \\"
echo "    --compatible-architectures ${ARCH} \\"
echo "    --region us-west-2"
