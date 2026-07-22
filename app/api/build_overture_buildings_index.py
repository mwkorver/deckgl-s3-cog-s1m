"""Build a tiny CONUS row-group index over the public Overture buildings release.

Unlike build_overture_buildings.py (which materializes a bbox-clipped copy of the
geometry), this tool stores no geometry at all. It scans the Overture parquet
footers (metadata only) and emits one row per row group whose bbox intersects
CONUS: the file key, the row-group ordinal, its row count, and its bbox extent.

/buildings/overture then bbox-prunes this index to a viewport, reads only the
matching row groups straight from Overture's public S3, and returns GeoJSON --
the same "thin index, stream the heavy data on demand from the authoritative S3"
strategy the NAIP/S1M lakes use, applied to vector footprints.

The output index is small (~8.5k rows for CONUS) and is published into the seed
bucket at lake/overture-buildings/index.parquet, from where deploy-foundation
seeds it into each deployer's lake. PyArrow is used for the source scan because
DuckDB/httpfs can hit range-read internal errors on this large public dataset.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter

import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as fs
import pyarrow.parquet as pq

DEFAULT_RELEASE = "2026-06-17.0"
DEFAULT_SOURCE = "overturemaps-us-west-2/release/{release}/theme=buildings/type=building"
# CONUS lon/lat envelope (OGC:CRS84). Deliberately a touch generous so coastal
# and border footprints are not clipped by a tight box.
CONUS_BBOX = (-125.0, 24.4, -66.9, 49.4)
DEFAULT_OUTPUT = "/cache/overture/buildings-index.parquet"
BBOX_CHILDREN = ("bbox.xmin", "bbox.ymin", "bbox.xmax", "bbox.ymax")


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    parts = [float(v.strip()) for v in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be xmin,ymin,xmax,ymax")
    xmin, ymin, xmax, ymax = parts
    if xmin >= xmax or ymin >= ymax:
        raise argparse.ArgumentTypeError("bbox min values must be less than max values")
    return xmin, ymin, xmax, ymax


def parse_args():
    parser = argparse.ArgumentParser(description="Build a CONUS row-group index over the Overture buildings release.")
    parser.add_argument(
        "--release", default=DEFAULT_RELEASE, help=f"Overture release id, for example {DEFAULT_RELEASE}"
    )
    parser.add_argument(
        "--source", default=DEFAULT_SOURCE, help="Source parquet dataset key (no scheme). May include {release}."
    )
    parser.add_argument(
        "--bbox", type=parse_bbox, default=None, help="Clip envelope xmin,ymin,xmax,ymax in OGC:CRS84 (default: CONUS)."
    )
    parser.add_argument("--region", default="us-west-2", help="AWS region of the source bucket.")
    parser.add_argument("--workers", type=int, default=24, help="Parallel footer reads.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Local output index parquet path.")
    parser.add_argument("--upload-uri", default=None, help="Optional s3://bucket/key to upload the finished index to.")
    return parser.parse_args()


def intersects(a, b) -> bool:
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def scan_file(filesystem, key: str, bbox) -> list[dict]:
    """Return one index record per row group in `key` whose extent hits bbox."""
    md = pq.ParquetFile(key, filesystem=filesystem).metadata
    col = {}
    rg0 = md.row_group(0)
    for i in range(rg0.num_columns):
        path = rg0.column(i).path_in_schema
        if path in BBOX_CHILDREN:
            col[path] = i
    if len(col) != len(BBOX_CHILDREN):
        raise SystemExit(f"{key}: expected bbox struct columns, found {sorted(col)}")
    records = []
    for r in range(md.num_row_groups):
        rg = md.row_group(r)
        ext = (
            rg.column(col["bbox.xmin"]).statistics.min,
            rg.column(col["bbox.ymin"]).statistics.min,
            rg.column(col["bbox.xmax"]).statistics.max,
            rg.column(col["bbox.ymax"]).statistics.max,
        )
        if intersects(ext, bbox):
            records.append(
                {
                    "file": key,
                    "row_group": r,
                    "num_rows": rg.num_rows,
                    "bbox_xmin": ext[0],
                    "bbox_ymin": ext[1],
                    "bbox_xmax": ext[2],
                    "bbox_ymax": ext[3],
                }
            )
    return records


def main():
    args = parse_args()
    bbox = args.bbox or CONUS_BBOX
    source = args.source.format(release=args.release)
    filesystem = fs.S3FileSystem(region=args.region, anonymous=True)

    started = perf_counter()
    print(f"source:  s3://{source}", flush=True)
    print(f"bbox:    {bbox}", flush=True)
    print(f"output:  {args.output}", flush=True)

    dataset = ds.dataset(source, filesystem=filesystem, format="parquet", partitioning="hive")
    files = dataset.files
    print(f"scanning {len(files)} footers with {args.workers} workers...", flush=True)

    records: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for chunk in ex.map(lambda k: scan_file(filesystem, k, bbox), files):
            records.extend(chunk)

    if not records:
        raise SystemExit("no Overture row groups intersected the requested bbox")

    files_hit = len({r["file"] for r in records})
    total_rows = sum(r["num_rows"] for r in records)
    print(f"row groups (index rows): {len(records):,}", flush=True)
    print(f"files touched:           {files_hit} / {len(files)}", flush=True)
    print(f"buildings (upper bound): {total_rows:,}", flush=True)

    table = pa.Table.from_pylist(records).replace_schema_metadata(
        {
            b"overture_release": args.release.encode(),
            b"overture_source": source.encode(),
            b"overture_region": args.region.encode(),
            b"index_bbox": ",".join(str(v) for v in bbox).encode(),
        }
    )
    pq.write_table(table, args.output, compression="zstd")
    print(f"wrote {args.output} in {perf_counter() - started:.1f}s", flush=True)

    if args.upload_uri:
        if not args.upload_uri.startswith("s3://"):
            raise SystemExit("--upload-uri must be an s3:// URI")
        no_scheme = args.upload_uri[5:]
        out_fs = fs.S3FileSystem(region=args.region)
        with open(args.output, "rb") as fh, out_fs.open_output_stream(no_scheme) as out:
            out.write(fh.read())
        print(f"uploaded -> {args.upload_uri}", flush=True)


if __name__ == "__main__":
    main()
