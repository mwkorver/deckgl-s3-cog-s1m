"""One-time migration: repartition the imagery lake from the pre-Phase-3
`state=/naip_year=/product=` layout to the universal `collection=/region=/year=`
layout (COLLECTIONS.md Phase 3). DuckDB-only -- it reads the existing parquet and
rewrites it; there are NO COG re-reads.

  reads:  <root>/state=*/naip_year=*/product=*/**.parquet     (old)
  writes: <root>/collection=<id>/region=*/year=*/**.parquet   (new)

Column mapping: `state`->`region`, `naip_year`->`year`, add `collection=<id>`;
the old `product`/`resolution_dir` fold into a `properties` JSON string
(`naip:product`/`naip:resolution`). geometry/bbox/proj_* carry over unchanged.

The new tree is written UNDER THE SAME ROOT, alongside the old `state=*` dirs
(they coexist). This script does NOT delete the old dirs -- it verifies the new
row count equals the old, then prints the exact cleanup command for you to run
once the redeployed API is confirmed reading the new layout.

Usage:
  python migrate_lake_layout.py --root s3://bucket/lake [--collection naip]
  python migrate_lake_layout.py --root /local/lake --dry-run
"""

import argparse
from time import perf_counter

import duckdb

import duckdb_s3


def parse_args():
    p = argparse.ArgumentParser(description="Repartition the lake to collection/region/year")
    p.add_argument("--root", required=True, help="Lake root (local path or s3://bucket/prefix)")
    p.add_argument("--collection", default="naip", help="Collection id for the migrated data")
    p.add_argument("--row-group-size", type=int, default=2000)
    p.add_argument("--dry-run", action="store_true", help="Count + plan only; write nothing")
    return p.parse_args()


def _old_glob(root):
    return f"{root}/state=*/naip_year=*/product=*/**/*.parquet"


def _new_glob(root, collection):
    return f"{root}/collection={collection}/**/*.parquet"


def main():
    args = parse_args()
    root = args.root.rstrip("/")
    started = perf_counter()

    con = duckdb.connect()
    duckdb_s3.configure(con, root, spatial=True)
    con.execute("INSTALL json; LOAD json;")

    old_glob = _old_glob(root)
    old_count = con.execute(
        f"select count(*) from read_parquet('{old_glob}', hive_partitioning=true)"
    ).fetchone()[0]
    print(f"old layout rows: {old_count:,}  ({old_glob})", flush=True)
    if old_count == 0:
        raise SystemExit("no old-layout (state=/naip_year=/product=) data found; nothing to migrate")

    # geometry may come back as GEOMETRY (spatial auto-decode) or as a WKB BLOB
    # depending on the DuckDB/spatial version -- detect and coerce accordingly.
    geom_type = con.execute(
        f"describe select geometry from read_parquet('{old_glob}', hive_partitioning=true) limit 1"
    ).fetchall()[0][1]
    geom_expr = "geometry" if "GEOMETRY" in geom_type.upper() else "ST_GeomFromWKB(geometry)"
    print(f"geometry source type: {geom_type} -> {geom_expr}", flush=True)

    if args.dry_run:
        print("dry-run: no write. Would write to", _new_glob(root, args.collection), flush=True)
        con.close()
        return

    copy_opts = (
        "format parquet, geoparquet_version 'V2', "
        f"row_group_size {args.row_group_size}, "
        "partition_by (collection, region, year), overwrite_or_ignore true"
    )
    con.execute(
        f"""
        copy (
          select
            source_bucket, source_key, asset_href,
            '{args.collection}' as collection,
            state as region,
            naip_year as year,
            CAST(to_json({{'naip:product': product, 'naip:resolution': resolution_dir}}) AS VARCHAR) as properties,
            {geom_expr} as geometry,
            bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
            acquisition_date, gsd, proj_epsg, proj_bbox, proj_shape, proj_transform
          from read_parquet('{old_glob}', hive_partitioning=true)
          order by state, naip_year
        ) to '{root}' ({copy_opts});
        """
    )

    new_glob = _new_glob(root, args.collection)
    new_count = con.execute(
        f"select count(*) from read_parquet('{new_glob}', hive_partitioning=true)"
    ).fetchone()[0]
    con.close()

    elapsed = perf_counter() - started
    print(f"new layout rows: {new_count:,}  ({new_glob})", flush=True)
    print(f"elapsed: {elapsed:.1f}s", flush=True)
    if new_count != old_count:
        raise SystemExit(
            f"ROW COUNT MISMATCH: old={old_count:,} new={new_count:,} -- do NOT delete the old tree"
        )

    print("\nOK: new == old row count. New layout written alongside the old.", flush=True)
    print("Once the redeployed API verifies reads of the new layout, delete the old tree:", flush=True)
    if root.startswith("s3://"):
        bucket = root[len("s3://"):].split("/", 1)[0]
        prefix = root[len("s3://"):].split("/", 1)[1] if "/" in root[len("s3://"):] else ""
        print(f"  aws s3 rm s3://{bucket}/{prefix}/ --recursive --exclude '*' --include 'state=*'", flush=True)
        print("  (or per-state:  aws s3 rm s3://.../state=<st>/ --recursive)", flush=True)
    else:
        print(f"  rm -rf {root}/state=*", flush=True)


if __name__ == "__main__":
    main()
