"""Local SAM3 feasibility test on a single NAIP COG.

Pipeline:  DuckDB (discovery over the GeoParquet lake)  ->  rasterio (pixel read)  ->  model.

DuckDB picks the COG + window from the lake's bbox/geometry columns; rasterio reads
the actual pixels (DuckDB cannot read raster bands). Both the lake read and the COG
read hit the requester-pays `naip-analytic` bucket, so S3 + requester-pays are wired
for each.

Run (Apple Silicon):
    AWS_PROFILE=cog-stac-deploy \
    PYTORCH_ENABLE_MPS_FALLBACK=1 python test_sam3_cog.py --lon -71.5 --lat 41.7 --year 2021
"""

import argparse
import os

import duckdb
import numpy as np
import rasterio

# Same root your service uses; local Parquet dir or an s3:// prefix.
LAKE_ROOT = os.environ.get("S3_COG_LAKE_ROOT", "s3://cog-stac-catalog")
REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-west-2")


def pick_cog(lon: float, lat: float, year: int | None, region: str | None, collection: str = "naip"):
    """DuckDB discovery: which COG covers (lon, lat), and its native georef."""
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    if str(LAKE_ROOT).startswith("s3://"):
        con.execute("INSTALL httpfs; LOAD httpfs;")
        con.execute(f"CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION '{REGION}');")
        con.execute("SET s3_requester_pays=true;")

    # Mirror app.py: scope the glob to the partition prefix so the S3 LIST is cheap,
    # prune with the bbox_* columns, confirm with ST_Intersects.
    safe_region = "".join(c for c in region.lower() if c.isalnum()) if region else None
    
    base = f"{LAKE_ROOT}/collection={collection}"
    if safe_region and year:
        glob = f"{base}/region={safe_region}/year={year}/**/*.parquet"
    elif safe_region:
        glob = f"{base}/region={safe_region}/**/*.parquet"
    elif year:
        glob = f"{base}/*/year={year}/**/*.parquet"
    else:
        glob = f"{base}/**/*.parquet"

    filters = [
        f"bbox_xmin <= {lon} and bbox_xmax >= {lon}",
        f"bbox_ymin <= {lat} and bbox_ymax >= {lat}",
        f"ST_Intersects(geometry, ST_Point({lon}, {lat}))",
    ]
    if year:
        filters.append(f"year = {year}")
    if safe_region:
        filters.append(f"region = '{safe_region}'")

    row = con.execute(f"""
        select asset_href, source_key, region, year, gsd,
               proj_epsg, proj_shape, proj_transform,
               bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax
        from read_parquet('{glob}', hive_partitioning=true)
        where {' and '.join(filters)}
        order by year desc, gsd asc nulls last, source_key asc
        limit 1
    """).fetchone()
    if not row:
        raise SystemExit(f"No COG covers ({lon}, {lat}) for year={year} region={region}")
    return dict(zip(
        ["asset_href", "source_key", "region", "year", "gsd",
         "proj_epsg", "proj_shape", "proj_transform",
         "bbox_xmin", "bbox_ymin", "bbox_xmax", "bbox_ymax"], row))


def read_window(asset_href: str, lon: float, lat: float, size: int = 1024) -> np.ndarray:
    """rasterio pixel read: a size x size RGB window centred on (lon, lat).

    asset_href is s3://naip-analytic/...; that bucket is requester-pays, so GDAL
    needs AWS_REQUEST_PAYER=requester (set below) and /vsis3/ access.
    """
    os.environ.setdefault("AWS_REQUEST_PAYER", "requester")
    vsi = "/vsis3/" + asset_href[len("s3://"):]
    with rasterio.open(vsi) as src:
        # COG is in UTM (proj_epsg); transform our lon/lat to row/col via the
        # dataset's own CRS. Simplest robust path: reproject the point.
        from rasterio.warp import transform as warp_transform
        xs, ys = warp_transform("EPSG:4326", src.crs, [lon], [lat])
        row, col = src.index(xs[0], ys[0])
        half = size // 2
        win = rasterio.windows.Window(col - half, row - half, size, size)
        arr = src.read([1, 2, 3], window=win, boundless=True, fill_value=0)
    return np.transpose(arr, (1, 2, 0))  # HWC uint8 for the model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--year", type=int, default=None)
    ap.add_argument("--region", type=str, default=None)
    ap.add_argument("--state", type=str, default=None, help="Deprecated alias for --region")
    ap.add_argument("--collection", type=str, default="naip", help="Collection ID (e.g. naip, kyfromabove, nj-imagery)")
    ap.add_argument("--size", type=int, default=1024)
    args = ap.parse_args()

    region = args.region or args.state
    cog = pick_cog(args.lon, args.lat, args.year, region, args.collection)
    print(f"COG: {cog['asset_href']}")
    print(f"  region={cog['region']} year={cog['year']} gsd={cog['gsd']} epsg={cog['proj_epsg']}")

    chip = read_window(cog["asset_href"], args.lon, args.lat, args.size)
    print(f"chip: shape={chip.shape} dtype={chip.dtype} "
          f"min={chip.min()} max={chip.max()} mean={chip.mean():.1f}")

    # Sanity dump so you can eyeball the clip before wiring a model in.
    try:
        from PIL import Image
        Image.fromarray(chip).save("chip.png")
        print("wrote chip.png")
    except ImportError:
        np.save("chip.npy", chip)
        print("wrote chip.npy (pip install pillow for a PNG)")

    # --- SAM3 / Grounded-SAM2 goes here ---
    # device = "mps" if torch.backends.mps.is_available() else "cpu"
    # masks = model(chip, text="car")   # whatever the released SAM3 API is
    # ...overlay masks on chip, dump GeoJSON using cog['proj_transform']...


if __name__ == "__main__":
    main()
