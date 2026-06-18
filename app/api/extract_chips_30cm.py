"""Extract 30cm NAIP test chips for SAM 3, targeting urban lon/lat points.

The local lake holds no 30cm imagery, so this bypasses the lake and discovers
COGs directly from the manifest index: for a given 1-degree USGS block (`quad`),
it reads each candidate COG's header bounds (threaded), builds a lon/lat index,
then for each target point reads a window from the covering COG.

naip-analytic is requester-pays, so AWS creds + AWS_REQUEST_PAYER=requester must
be in the environment (source ../.env first).

Usage:
  source ../.env && export AWS_REQUEST_PAYER=requester && unset AWS_PROFILE
  ../.venv/bin/python extract_chips_30cm.py
"""

import math
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import transform as warp_transform, transform_bounds
from rasterio.windows import Window

HERE = Path(__file__).resolve().parent
MANIFEST = os.environ.get(
    "S3_COG_MANIFEST_INDEX",
    str(HERE.parent / "cache" / "manifest_index"),
)
STATE, YEAR, RES = "la", 2021, "30cm"

# (name, lon, lat, suggested_prompt, stretch) — varied 30cm scenes around New
# Orleans. `stretch` applies a 2–98% per-channel contrast stretch; use it for
# scenes dominated by bright concrete (e.g. an airport apron) that otherwise wash
# out. Targets span the 30.0N line, so they fall in different 1-degree blocks; the
# block (manifest `quad`) is computed per target below.
TARGETS = [
    ("nola_cbd", -90.0758, 29.9509, "car", False),         # downtown: cars + roofs
    ("nola_airport", -90.2580, 29.9934, "airplane", True), # MSY: aircraft at gates
    ("lakeside_mall", -90.1527, 30.0033, "car", False),    # retail parking field
    ("metairie_pools", -90.1650, 29.9850, "swimming pool", False),  # backyards
    ("elmwood_bigbox", -90.1960, 29.9570, "rooftop hvac unit", False),  # big-box roofs
    ("lakefront_marina", -90.1130, 30.0260, "boat", False),  # West End marina
]
SIZE = 1008  # SAM 3's native input: the model resizes every chip to 1008x1008
# (img_size=1008), so cutting exactly 1008 native COG pixels feeds the encoder
# true pixels with no internal resample (COG-pixel = chip-pixel = model-pixel).
# 1008 px @ 30cm ≈ 302 m across.


def stretch_2_98(arr):
    """Per-channel 2–98 percentile contrast stretch to uint8. Rescales each band
    so the 2nd percentile -> 0 and the 98th -> 255, clipping outliers; rescues
    washed-out bright scenes (airport aprons) without touching well-exposed ones."""
    out = np.empty_like(arr)
    for c in range(arr.shape[2]):
        band = arr[:, :, c].astype(np.float32)
        lo, hi = np.percentile(band, (2, 98))
        if hi <= lo:
            out[:, :, c] = arr[:, :, c]
            continue
        out[:, :, c] = np.clip((band - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
    return out


def block_of(lon: float, lat: float) -> str:
    """Manifest `quad` = 1-degree block: south latitude + west longitude, e.g.
    (29.95, -90.07) -> '29090'."""
    return f"{math.floor(lat):02d}{math.floor(abs(lon)):03d}"


def list_keys(quad: str) -> list[str]:
    con = duckdb.connect()
    g = f"read_parquet('{MANIFEST}/**/*.parquet', hive_partitioning=true)"
    rows = con.execute(
        f"select source_key from {g} where resolution=? and state=? and naip_year=? and quad=? order by source_key",
        [RES, STATE, YEAR, quad],
    ).fetchall()
    return [r[0] for r in rows]


def bounds_of(key: str):
    """Return (key, (lon_min, lat_min, lon_max, lat_max)) reading only the header."""
    try:
        with rasterio.open("/vsis3/naip-analytic/" + key) as src:
            return key, transform_bounds(src.crs, "EPSG:4326", *src.bounds)
    except Exception:
        return key, None


def covering_key(index, lon, lat):
    for key, b in index:
        if b and b[0] <= lon <= b[2] and b[1] <= lat <= b[3]:
            return key
    return None


def read_window(key, lon, lat, size):
    with rasterio.open("/vsis3/naip-analytic/" + key) as src:
        xs, ys = warp_transform("EPSG:4326", src.crs, [lon], [lat])
        row, col = src.index(xs[0], ys[0])
        half = size // 2
        win = Window(col - half, row - half, size, size)
        arr = src.read([1, 2, 3], window=win, boundless=True, fill_value=0)
    return arr.transpose(1, 2, 0)  # HWC


def main():
    # Group targets by 1-degree block so each block's header index is built once.
    blocks = sorted({block_of(lon, lat) for _, lon, lat, *_ in TARGETS})
    index = []
    for quad in blocks:
        keys = list_keys(quad)
        print(f"block {quad}: {len(keys)} candidate COGs; reading header bounds ...")
        with ThreadPoolExecutor(max_workers=16) as ex:
            index += [(k, b) for k, b in ex.map(bounds_of, keys) if b]
    print(f"indexed {len(index)} COGs across {len(blocks)} block(s)\n")

    for name, lon, lat, prompt, stretch in TARGETS:
        key = covering_key(index, lon, lat)
        if not key:
            print(f"[{name}] no COG covers ({lon},{lat})")
            continue
        chip = read_window(key, lon, lat, SIZE)
        if stretch:
            chip = stretch_2_98(chip)
        out = f"chip_{name}.png"
        Image.fromarray(chip).save(out)
        print(f"[{name}] prompt={prompt!r} {key.split('/')[-1]} -> {out} "
              f"mean={chip.mean():.1f}{' [stretched]' if stretch else ''}")


if __name__ == "__main__":
    main()
