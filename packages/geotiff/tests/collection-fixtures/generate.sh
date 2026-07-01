#!/usr/bin/env bash
# Regenerate small COG fixtures mirroring the real COG types across our
# collections, for collection-cog-decode.test.ts. Committed .tif outputs are
# tiny (256x256, 128px tiles -> 4 tiles). Re-run only when adding a collection
# COG shape. Requires GDAL.
#
# Each band is burned with a distinct constant (b0=10, b1=20, ...) so the decode
# test can assert both the RasterArray shape AND the interleaved band order.
#
# NOTE: LERC-compressed fixtures (Vermont VTORTHO) are NOT generated here --
# this GDAL build lacks the LERC write codec. LERC decode layout (the chunky vs
# planar mapping that broke on Vermont CLRIR) is covered by the mocked
# lerc-layout unit test in collection-cog-decode.test.ts instead.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

mk() { # mk <name> <ot> <nbands> <extra cog -co...>
  local name="$1" ot="$2" n="$3"; shift 3
  local burns=(); for ((b=1;b<=n;b++)); do burns+=(-burn $((b*10))); done
  gdal_create -q -outsize 256 256 -bands "$n" -ot "$ot" \
    -a_srs EPSG:4326 -a_ullr -73 45 -72 44 "${burns[@]}" "$tmp/base.tif"
  gdal_translate -q "$tmp/base.tif" "$name.tif" -of COG -co BLOCKSIZE=128 \
    -co COMPRESS=DEFLATE -co INTERLEAVE=PIXEL "$@"
}

mk uint8_4band_chunky_deflate  Byte   4   # NAIP / Indiana (RGBIR)
mk uint8_3band_chunky_deflate  Byte   3   # KyFromAbove / RGB
mk uint16_4band_chunky_deflate UInt16 4   # New Jersey (16-bit)
mk uint8_1band_deflate         Byte   1   # single-band (PAN-shaped)

echo "generated:"; ls -1 *.tif
