"""PostGIS-free NAIP ingest: manifest payloads -> DuckDB -> GeoParquet lake.

This is the SECOND, independent ingest path, kept separate from the
PostGIS-staged pair (ingest_iceberg.py + export_iceberg.py) so the two can be
benchmarked side by side. It writes to its own output root.

Pipeline:

    manifest/STAC (ingest_manifest.py, shared read-only acquisition)
      -> Arrow table of payloads
      -> DuckDB: ST_GeomFromGeoJSON -> geometry
                 ST_X/Y Min/Max     -> bbox_* columns
                 ORDER BY ST_Hilbert(geometry, per-region extent)  (clustering)
      -> COPY ... partition_by(collection, region, year), geoparquet_version V2
      -> collection=/region=/year= GeoParquet tree (+ a properties JSON column)

No Postgres, no staging table, no generated columns. DuckDB does every spatial
step the old path split between PostGIS (geom/bbox) and DuckDB (clustering,
write). The output files are byte-for-byte the same contract a pg_duckdb or
DuckDB-on-Lambda reader consumes -- only the WRITE engine differs from the old
path. The only thing shared with the old ingest is ingest_manifest.py's pure
data-acquisition layer (manifest scan + EarthSearch + proj->4326 geometry).
"""

import argparse
import json
import os
from pathlib import Path
from time import perf_counter

import descriptors
import duckdb
import ingest_manifest as im
import pyarrow as pa

# Lake root the read API serves from (S3_COG_LAKE_ROOT), so a panel-triggered
# ingest writes where /search reads -- local or s3://. Falls back to the local
# cache path for standalone CLI runs without the env set.
DEFAULT_OUT = os.environ.get("S3_COG_LAKE_ROOT", "/cache/exports/naip_rgbir_duckdb")

# Encoding suffixes the manifest appends to the band product ("rgbir_cog").
# The format token describes the encoding, not the product, so it is dropped.
_PRODUCT_FORMAT_SUFFIXES = ("_cog", "_cogs")


def derive_product(product_family) -> str | None:
    """Reduce a manifest product_family (e.g. "rgbir_cog") to the band product
    users filter on ("rgbir" | "rgb")."""
    if not product_family:
        return None
    pf = str(product_family).lower()
    for suffix in _PRODUCT_FORMAT_SUFFIXES:
        if pf.endswith(suffix):
            return pf[: -len(suffix)]
    return pf


def parse_args():
    parser = argparse.ArgumentParser(
        description="PostGIS-free STAC/COG collection ingest: manifest/listing -> DuckDB -> GeoParquet lake"
    )
    parser.add_argument(
        "--collection",
        default="naip",
        help="Collection id from the descriptor registry (e.g. naip, kyfromabove, nj-imagery)",
    )
    parser.add_argument("--states", nargs="+", default=["ri", "ct", "de", "nj"])
    parser.add_argument("--years", nargs="+", type=int, help="Optional explicit acquisition years")
    parser.add_argument(
        "--latest-year-only",
        action="store_true",
        help="For each state, ingest only the most recent year found in the manifest",
    )
    parser.add_argument(
        "--limit-per-partition",
        type=int,
        default=0,
        help="Optional cap per state/year/resolution partition; 0 means all",
    )
    parser.add_argument(
        "--strategy",
        choices=["manifest-earthsearch", "manifest-cog-headers"],
        # Default to querying EarthSearch STAC API (manifest-earthsearch) because
        # it is significantly faster. If any tiles are missing from EarthSearch,
        # it automatically falls back to reading S3 COG headers directly to
        # guarantee 100% completeness. Use manifest-cog-headers to bypass EarthSearch
        # completely and read all headers from S3.
        default="manifest-earthsearch",
    )
    parser.add_argument("--page-size", type=int, default=im.EARTHSEARCH_PAGE_SIZE)
    parser.add_argument(
        "--strict-completeness",
        action="store_true",
        help="Abort before writing if any (state, year) partition ingests fewer "
        "rows than the manifest/bucket lists (completeness = correctness).",
    )
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output GeoParquet tree root")
    parser.add_argument(
        "--row-group-size",
        type=int,
        default=2000,
        help="Parquet row group size; smaller groups give finer bbox-stat pruning",
    )
    parser.add_argument(
        "--single-file",
        action="store_true",
        help="Write one file instead of the collection=/region=/year= partition tree",
    )
    parser.add_argument("--source-bucket", help="S3 bucket for ad-hoc collections")
    parser.add_argument("--source-prefix", help="S3 prefix for ad-hoc collections")
    parser.add_argument("--source-access", default="public", help="Access mode (public, private, requester-pays)")
    parser.add_argument(
        "--max-workers",
        type=int,
        default=16,
        help="Number of concurrent worker threads to run (default 16)",
    )
    parser.add_argument("--source-access-key-id", help="AWS Access Key ID for S3 client authentication")
    parser.add_argument("--source-secret-access-key", help="AWS Secret Access Key for S3 client authentication")
    return parser.parse_args()


def acquire_payloads(args):
    """Run the shared data-acquisition layer and return row-store payloads.
    Mirrors ingest_iceberg.acquire_payloads so both paths ingest identical
    source data (the only difference is the sink)."""
    # Resolve the collection descriptor. The descriptor
    # owns the source bucket, access mode, and discovery adapter, so this function
    # no longer hardcodes NAIP's manifest-index discovery or requester-pays.
    source_bucket = getattr(args, "source_bucket", None)
    if source_bucket:
        source_prefix = getattr(args, "source_prefix", "") or ""
        source_access = getattr(args, "source_access", "public") or "public"
        state = args.states[0] if args.states else "unknown"
        year = args.years[0] if args.years else 2026

        descriptor = descriptors.register_adhoc_collection(
            collection_id=args.collection,
            bucket=source_bucket,
            prefix=source_prefix,
            region=state,
            year=year,
            access=source_access,
        )
    else:
        descriptor = descriptors.get_descriptor(args.collection)

    args.collection = descriptor.id

    states = {state.lower() for state in args.states}
    years = set(args.years) if args.years else None
    # Discovery via the descriptor's adapter. For NAIP this is the partitioned
    # Parquet manifest index (pushdown by state/naip_year) instead of streaming the
    # 404MB text manifest -- a transparent wrapper, output identical to the old
    # direct call (proven by the equivalence test).
    manifest_rows, latest_by_state = descriptor.discovery.enumerate(
        regions=states,
        years=years,
        latest_year_only=args.latest_year_only,
        limit_per_partition=args.limit_per_partition,
    )

    # Generic public-prefix collections (S3PrefixListing): the discovery rows
    # already carry region/year/properties; read COG headers and attach them. No
    # NAIP filename parse, no strategy choice (header read is the only path).
    if isinstance(descriptor.discovery, descriptors.S3PrefixListing):
        payloads, failed = im.process_cog_headers_generic(
            manifest_rows, max_workers=args.max_workers,
            request_payer=descriptor.request_payer, access=descriptor.access,
            aws_access_key_id=args.source_access_key_id,
            aws_secret_access_key=args.source_secret_access_key,
        )
        print(f"COG header extraction: matched={len(payloads):,} failed={len(failed):,}", flush=True)
        reconcile_completeness(manifest_rows, payloads, collection=args.collection,
                               strict=args.strict_completeness)
        return payloads

    if args.strategy == "manifest-cog-headers":
        payloads, failed = im.process_manifest_cog_headers(
            manifest_rows, max_workers=args.max_workers, request_payer=descriptor.request_payer,
            aws_access_key_id=args.source_access_key_id,
            aws_secret_access_key=args.source_secret_access_key,
        )
        print(f"COG header extraction: matched={len(payloads):,} failed={len(failed):,}", flush=True)
    else:
        years_by_state = {}
        for state in states:
            if args.latest_year_only:
                years_by_state[state] = latest_by_state.get(state)
            elif years and len(years) == 1:
                years_by_state[state] = next(iter(years))
            else:
                years_by_state[state] = None

        stac_index = im.build_stac_index(states, years_by_state, args.page_size)
        payloads = []
        missing_rows = {}
        for asset_href, manifest_row in manifest_rows.items():
            item = stac_index.get(asset_href)
            if item is None:
                missing_rows[asset_href] = manifest_row
                continue
            payloads.append(im.row_to_insertable(manifest_row, item))
        print(f"join results matched={len(payloads):,} manifest_only_missing_stac={len(missing_rows):,}", flush=True)

        if missing_rows:
            print(
                f"Warning: {len(missing_rows):,} assets missing from EarthSearch STAC. "
                "Falling back to S3 COG header parsing for these assets...",
                flush=True,
            )
            fallback_payloads, failed = im.process_manifest_cog_headers(
                missing_rows, max_workers=args.max_workers, request_payer=descriptor.request_payer,
                aws_access_key_id=args.source_access_key_id,
                aws_secret_access_key=args.source_secret_access_key,
            )
            payloads.extend(fallback_payloads)
            print(
                f"Fallback COG header extraction: matched={len(fallback_payloads):,} failed={len(failed):,}",
                flush=True,
            )

    # Completeness reconciliation: the manifest index mirrors the authoritative
    # bucket listing, so any per-partition shortfall here is a silent data loss
    # (the EarthSearch path's failure mode). Flag it loudly; optionally fail.
    reconcile_completeness(manifest_rows, payloads, collection=args.collection,
                           strict=args.strict_completeness)
    return payloads


def reconcile_completeness(manifest_rows, payloads, collection="naip", strict=False):
    """Compare ingested rows vs the manifest (bucket-authoritative) per
    (collection, region, year). Prints a table and warns/raises on any shortfall.
    The NAIP rows still carry state/naip_year upstream, which map 1:1 to
    region/year within a single-collection run."""
    from collections import Counter

    def _ry(d):  # (region, year), from either the generic or NAIP shape
        return (d.get("region", d.get("state")), int(d.get("year", d.get("naip_year"))))

    man = Counter(_ry(r) for r in manifest_rows.values())
    got = Counter(_ry(p) for p in payloads)

    print(f"\n=== completeness reconciliation (collection={collection}, ingested vs manifest) ===", flush=True)
    print(f"{'region':6s} {'year':6s} {'manifest':>9s} {'ingested':>9s} {'dropped':>8s}  pct", flush=True)
    shortfalls = []
    for key in sorted(man):
        m = man[key]
        g = got.get(key, 0)
        drop = m - g
        pct = 100.0 * g / m if m else 0.0
        flag = "  <-- INCOMPLETE" if drop else ""
        print(f"{key[0]:6s} {key[1]:<6d} {m:9,d} {g:9,d} {drop:8,d}  {pct:5.1f}%{flag}", flush=True)
        if drop:
            shortfalls.append((key, m, g, drop))

    if shortfalls:
        total_drop = sum(s[3] for s in shortfalls)
        msg = (f"COMPLETENESS WARNING: {len(shortfalls)} partition(s) short by "
               f"{total_drop:,} rows vs the manifest/bucket.")
        if strict:
            raise SystemExit(f"{msg} (--strict-completeness set; aborting before write)")
        print(f"\n!!! {msg} Proceeding anyway (re-run with --strict-completeness to abort).", flush=True)
    else:
        print("\nOK: every partition ingested 100% of its manifest tiles.", flush=True)


def _float_array(values):
    if values is None:
        return None
    return [float(v) for v in values]


def _int_array(values):
    if values is None:
        return None
    return [int(v) for v in values]


def payloads_to_arrow(payloads, collection: str) -> pa.Table:
    """Flatten payloads into a columnar Arrow table DuckDB can scan directly.
    geom stays as GeoJSON text here; DuckDB parses it to GEOMETRY in the COPY.

    Phase 3: emits the universal collection/region/year shape. The NAIP discovery
    + header payload upstream still carries state/naip_year/product (unchanged);
    we map state->region and naip_year->year here, and fold the NAIP-specific
    quad/resolution/product into a `properties` JSON string. (Generalizing the
    upstream reader off NAIP names is Phase 4.)"""
    rows = []
    for p in payloads:
        # Canonical region/year/properties when present (generic adapter); else map
        # from the NAIP payload (state/naip_year + product/resolution/quad).
        if "region" in p:
            region = p["region"]
            year = int(p["year"])
            properties = dict(p.get("properties") or {})
            proj_bbox = p.get("proj_bbox")
        else:
            region = p["state"]
            year = int(p["naip_year"])
            properties = {
                "naip:product": derive_product(p.get("product_family")),
                "naip:resolution": p.get("resolution_dir"),
                "naip:quad": p.get("spatial_prefix"),
            }
            proj_bbox = None
        properties = {k: v for k, v in properties.items() if v is not None}
        if proj_bbox is None:
            raw_raster = p.get("raw_raster")
            if raw_raster:
                try:
                    proj_bbox = json.loads(raw_raster).get("proj:bbox")
                except (TypeError, ValueError):
                    proj_bbox = None
        rows.append(
            {
                "source_bucket": p["source_bucket"],
                "source_key": p["source_key"],
                "asset_href": p["asset_href"],
                "collection": collection,
                "region": region,
                "year": year,
                "properties": json.dumps(properties),
                "geom_geojson": p["geom_geojson"],
                "acquisition_date": p.get("acquisition_date"),
                "gsd": p.get("gsd"),
                "proj_epsg": int(p["proj_epsg"]),
                "proj_bbox": _float_array(proj_bbox),
                "proj_shape": _int_array(p.get("proj_shape")),
                "proj_transform": _float_array(p.get("proj_transform")),
            }
        )
    return pa.Table.from_pylist(rows)


def _delete_partition_prefixes(
    out_path: str,
    parts,
    aws_access_key_id: str | None = None,
    aws_secret_access_key: str | None = None,
) -> None:
    """Remove the (collection, region, year) partition dirs we're about to
    rewrite, so a re-ingest replaces rather than appends.

    DuckDB's `overwrite_or_ignore true` does NOT delete pre-existing files in a
    partition -- it leaves them in place and writes a new data_N.parquet
    alongside, which yields duplicate rows on read. We clear only the exact
    partitions this run produces (not the whole state), so re-ingesting one
    year leaves the other years intact. Scoped to local FS or our own S3 lake.
    """
    is_s3 = str(out_path).startswith("s3://")
    if is_s3:
        import boto3

        bucket, _, base_key = out_path[len("s3://"):].partition("/")
        base_key = base_key.rstrip("/")
        region_name = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-west-2")
        if aws_access_key_id and aws_secret_access_key:
            session = boto3.Session(
                aws_access_key_id=aws_access_key_id,
                aws_secret_access_key=aws_secret_access_key,
                aws_session_token=None,
            )
            s3 = session.client("s3", region_name=region_name)
        else:
            s3 = boto3.client("s3", region_name=region_name)

    for collection, region, year in parts:
        rel = f"collection={collection}/region={region}/year={year}"
        if is_s3:
            prefix = f"{base_key}/{rel}/" if base_key else f"{rel}/"
            paginator = s3.get_paginator("list_objects_v2")
            keys = [
                {"Key": obj["Key"]}
                for page in paginator.paginate(
                    Bucket=bucket, Prefix=prefix, RequestPayer="requester"
                )
                for obj in page.get("Contents", [])
            ]
            for i in range(0, len(keys), 1000):
                s3.delete_objects(
                    Bucket=bucket,
                    Delete={"Objects": keys[i : i + 1000]},
                    RequestPayer="requester",
                )
            if keys:
                print(f"cleared s3://{bucket}/{prefix} ({len(keys)} objects)", flush=True)
        else:
            import shutil

            p = Path(out_path) / rel
            if p.exists():
                shutil.rmtree(p)
                print(f"cleared {p}", flush=True)


def export(
    payloads,
    out_path: str,
    row_group_size: int,
    single_file: bool,
    collection: str,
    aws_access_key_id: str | None = None,
    aws_secret_access_key: str | None = None,
) -> int:
    table = payloads_to_arrow(payloads, collection)  # noqa: F841 -- referenced by DuckDB scan

    import duckdb_s3

    # Only create local directories; for s3:// the COPY writes objects directly
    # via httpfs (no local filesystem layout to prepare).
    if not str(out_path).startswith("s3://"):
        out = Path(out_path)
        if single_file:
            out.parent.mkdir(parents=True, exist_ok=True)
        else:
            out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    duckdb_s3.configure(
        con, out_path, spatial=True,
        aws_access_key_id=aws_access_key_id,
        aws_secret_access_key=aws_secret_access_key,
    )
    con.register("staging", table)

    if not single_file:
        # Clear the partitions we're about to write so overwrite_or_ignore
        # doesn't leave stale data_N.parquet behind (duplicate rows on read).
        parts = con.execute(
            "select distinct collection, region, year from staging"
        ).fetchall()
        _delete_partition_prefixes(out_path, parts, aws_access_key_id, aws_secret_access_key)

    if single_file:
        copy_opts = f"format parquet, geoparquet_version 'V2', row_group_size {row_group_size}"
    else:
        copy_opts = (
            "format parquet, geoparquet_version 'V2', "
            f"row_group_size {row_group_size}, "
            "partition_by (collection, region, year), overwrite_or_ignore true"
        )

    # geometry from GeoJSON; bbox_* derived in DuckDB (the old path's PostGIS
    # generated columns); spatial clustering via ST_Hilbert over per-region
    # bounds. Universal layout: collection/region/year + a properties JSON column.
    con.execute(
        f"""
        copy (
          with src as (
            select
              source_bucket, source_key, asset_href,
              collection, region, year, properties,
              ST_GeomFromGeoJSON(geom_geojson) as geometry,
              try_cast(acquisition_date as date) as acquisition_date,
              gsd, proj_epsg, proj_bbox, proj_shape, proj_transform
            from staging
          ),
          geo as (
            select
              * exclude (geometry),
              geometry,
              ST_XMin(geometry) as bbox_xmin,
              ST_YMin(geometry) as bbox_ymin,
              ST_XMax(geometry) as bbox_xmax,
              ST_YMax(geometry) as bbox_ymax
            from src
          ),
          region_bounds as (
            select region, ST_Extent(ST_Extent_Agg(geometry)) as ext
            from geo
            group by region
          )
          select
            geo.source_bucket, geo.source_key, geo.asset_href,
            geo.collection, geo.region, geo.year, geo.properties,
            geo.geometry,
            geo.bbox_xmin, geo.bbox_ymin, geo.bbox_xmax, geo.bbox_ymax,
            geo.acquisition_date, geo.gsd,
            geo.proj_epsg, geo.proj_bbox, geo.proj_shape, geo.proj_transform
          from geo
          join region_bounds using (region)
          order by geo.collection, geo.region, geo.year,
                   ST_Hilbert(geo.geometry, region_bounds.ext)
        ) to '{out_path}' ({copy_opts});
        """
    )

    # Scope to the hive-partitioned data only. A bare `**/*.parquet` over the
    # lake root also matches non-partitioned siblings that share the bucket
    # (e.g. lake/s1m/S1M_Products.parquet), which have no collection= key and
    # break hive_partitioning with a "key collection not found" binder error.
    read_glob = str(out_path) if single_file else f"{out_path}/collection=*/region=*/year=*/*.parquet"
    count = con.sql(
        f"select count(*) from read_parquet('{read_glob}', hive_partitioning=true)"
    ).fetchone()[0]
    con.close()
    return count


def main():
    started_at = perf_counter()
    args = parse_args()

    payloads = acquire_payloads(args)
    count = export(
        payloads, args.out, args.row_group_size, args.single_file, args.collection,
        args.source_access_key_id, args.source_secret_access_key,
    )

    total_ms = (perf_counter() - started_at) * 1000
    print(f"timings total_ms={total_ms:.1f}", flush=True)
    print(f"done: wrote {count} rows to {args.out}", flush=True)


if __name__ == "__main__":
    main()
