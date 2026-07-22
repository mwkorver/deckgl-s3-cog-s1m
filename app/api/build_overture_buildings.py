"""Build a clipped GeoParquet file from Overture Maps building footprints.

The source Overture buildings release is global and very large. This tool is
bbox-scoped by default so local runs produce a usable file without materializing
the world. It uses PyArrow instead of DuckDB for the source scan because DuckDB
1.5.3/httpfs can hit range-read internal errors on this large public S3 dataset.
"""

import argparse
import json
from pathlib import Path
from time import perf_counter

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as fs
import pyarrow.parquet as pq

DEFAULT_RELEASE = "2026-06-17.0"
DEFAULT_SOURCE = (
    "s3://overturemaps-us-west-2/release/"
    "{release}/theme=buildings/type=building"
)
DEFAULT_OUTPUT = "/cache/overture/buildings_nj.parquet"
REGION_BBOXES = {
    "nj": (-75.6, 38.8, -73.8, 41.4),
}
OUTPUT_COLUMNS = [
    "id",
    "level",
    "height",
    "min_height",
    "is_underground",
    "num_floors",
    "num_floors_underground",
    "min_floor",
    "subtype",
    "class",
    "facade_color",
    "facade_material",
    "roof_material",
    "roof_shape",
    "roof_direction",
    "roof_orientation",
    "roof_color",
    "roof_height",
    "geometry",
    "has_parts",
    "version",
]


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    parts = [float(v.strip()) for v in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be xmin,ymin,xmax,ymax")
    xmin, ymin, xmax, ymax = parts
    if xmin >= xmax or ymin >= ymax:
        raise argparse.ArgumentTypeError("bbox min values must be less than max values")
    return xmin, ymin, xmax, ymax


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export a bbox-clipped Overture buildings GeoParquet file."
    )
    parser.add_argument(
        "--release",
        default=DEFAULT_RELEASE,
        help=f"Overture release id, for example {DEFAULT_RELEASE}",
    )
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        help="Source parquet dataset directory. May include {release}.",
    )
    parser.add_argument(
        "--bbox",
        type=parse_bbox,
        help="Clip bbox as xmin,ymin,xmax,ymax in OGC:CRS84 lon/lat.",
    )
    parser.add_argument(
        "--region",
        choices=sorted(REGION_BBOXES),
        default="nj",
        help="Named bbox to use when --bbox is omitted.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output GeoParquet file path.",
    )
    parser.add_argument("--limit", type=int, default=0, help="Optional row limit for smoke tests.")
    parser.add_argument("--row-group-size", type=int, default=10000)
    parser.add_argument("--batch-size", type=int, default=65536)
    return parser.parse_args()


def dataset_for_source(source: str):
    if source.startswith("s3://"):
        no_scheme = source[5:]
        filesystem = fs.S3FileSystem(region="us-west-2", anonymous=True)
        return ds.dataset(no_scheme, filesystem=filesystem, format="parquet", partitioning="hive")
    return ds.dataset(source, format="parquet", partitioning="hive")


def update_geo_metadata(metadata: dict[bytes, bytes] | None, bbox: list[float]) -> dict[bytes, bytes]:
    next_metadata = dict(metadata or {})
    raw = next_metadata.get(b"geo")
    if not raw:
        return next_metadata
    geo = json.loads(raw.decode("utf-8"))
    primary = geo.get("primary_column", "geometry")
    columns = geo.setdefault("columns", {})
    column_meta = columns.setdefault(primary, {})
    column_meta["bbox"] = bbox
    next_metadata[b"geo"] = json.dumps(geo, separators=(",", ":")).encode("utf-8")
    return next_metadata


def flatten_batch(batch: pa.RecordBatch) -> pa.RecordBatch:
    arrays = [batch.column(name) for name in OUTPUT_COLUMNS]
    names = list(OUTPUT_COLUMNS)
    arrays.append(pa.array(["buildings"] * batch.num_rows, type=pa.string()))
    names.append("theme")
    arrays.append(pa.array(["building"] * batch.num_rows, type=pa.string()))
    names.append("type")
    bbox_col = batch.column("bbox")
    bbox = bbox_col.combine_chunks() if isinstance(bbox_col, pa.ChunkedArray) else bbox_col
    for child_name, out_name in (
        ("xmin", "bbox_xmin"),
        ("ymin", "bbox_ymin"),
        ("xmax", "bbox_xmax"),
        ("ymax", "bbox_ymax"),
    ):
        arrays.append(pc.struct_field(bbox, child_name))
        names.append(out_name)
    return pa.RecordBatch.from_arrays(arrays, names=names)


def batch_extent(batch: pa.RecordBatch) -> tuple[float, float, float, float]:
    return (
        pc.min(batch.column("bbox_xmin")).as_py(),
        pc.min(batch.column("bbox_ymin")).as_py(),
        pc.max(batch.column("bbox_xmax")).as_py(),
        pc.max(batch.column("bbox_ymax")).as_py(),
    )


def merge_extent(
    current: tuple[float, float, float, float] | None,
    next_extent: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    if current is None:
        return next_extent
    return (
        min(current[0], next_extent[0]),
        min(current[1], next_extent[1]),
        max(current[2], next_extent[2]),
        max(current[3], next_extent[3]),
    )


def main():
    args = parse_args()
    bbox = args.bbox or REGION_BBOXES[args.region]
    xmin, ymin, xmax, ymax = bbox
    source = args.source.format(release=args.release)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    started = perf_counter()
    print(f"source: {source}", flush=True)
    print(f"bbox: {xmin},{ymin},{xmax},{ymax}", flush=True)
    print(f"output: {output}", flush=True)

    dataset = dataset_for_source(source)
    bbox_filter = (
        (ds.field("bbox", "xmax") >= xmin)
        & (ds.field("bbox", "xmin") <= xmax)
        & (ds.field("bbox", "ymax") >= ymin)
        & (ds.field("bbox", "ymin") <= ymax)
    )
    scanner = dataset.scanner(
        columns=[*OUTPUT_COLUMNS, "bbox"],
        filter=bbox_filter,
        batch_size=args.batch_size,
    )

    writer = None
    row_count = 0
    rows_with_height = 0
    extent = None
    try:
        for source_batch in scanner.to_batches():
            if source_batch.num_rows == 0:
                continue
            batch = flatten_batch(source_batch)
            if args.limit and row_count + batch.num_rows > args.limit:
                batch = batch.slice(0, args.limit - row_count)
            if batch.num_rows == 0:
                break

            rows_with_height += pc.count(batch.column("height")).as_py()
            extent = merge_extent(extent, batch_extent(batch))

            if writer is None:
                metadata = update_geo_metadata(dataset.schema.metadata, list(bbox))
                schema = batch.schema.with_metadata(metadata)
                writer = pq.ParquetWriter(
                    output,
                    schema,
                    compression="zstd",
                    version="2.6",
                    write_statistics=True,
                )
            writer.write_batch(batch, row_group_size=args.row_group_size)
            row_count += batch.num_rows
            if row_count and row_count % 500000 < batch.num_rows:
                print(f"rows: {row_count:,}", flush=True)
            if args.limit and row_count >= args.limit:
                break
    finally:
        if writer is not None:
            writer.close()

    if row_count == 0:
        raise SystemExit("no Overture buildings matched the requested bbox")

    elapsed = perf_counter() - started
    print(f"rows: {row_count:,}", flush=True)
    print(
        "extent: "
        f"{extent[0]:.6f},{extent[1]:.6f},{extent[2]:.6f},{extent[3]:.6f}",
        flush=True,
    )
    print(f"rows_with_height: {rows_with_height:,}", flush=True)
    print(f"elapsed: {elapsed:.1f}s", flush=True)


if __name__ == "__main__":
    main()
