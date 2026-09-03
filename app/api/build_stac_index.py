"""Project the GeoParquet lake into the published stac-geoparquet index.

The index at s3://naip-geoparquet-index/manifest-index is what external readers
consume (one STAC Item per COG: id/geometry/bbox/datetime/properties/assets). It
is a *projection* of the lake -- verified: the lake's `collection=naip` and the
index's `collection=naip-analytic` hold exactly the same 295,232 rows across the
same 51 regions and 12 years -- but until now nothing in this repo produced it,
so it could not be regenerated or tuned.

Three writer settings are load-bearing and easy to lose:

  geoparquet_version 'V2'   Without it DuckDB writes NO GeospatialStatistics:
                            measured 6/6 row groups carrying `geo_bbox` with the
                            option, 0/6 without (and 0/6 with 'V1'). Those
                            per-row-group extents are what let a reader skip row
                            groups, so dropping them silently removes the
                            index's spatial pruning.

  row_group_size            2048 is a FLOOR: DuckDB clamps this to a multiple of
                            its vector size, so 1845, 1024 and 512 all produce a
                            byte-identical file. The published layout is
                            [2048 x 5, 830], not the ~1,845/group an earlier
                            comment here claimed (that was 11070/6 arithmetic,
                            not a measurement).

                            2048 WAS THE WRONG VALUE, measured 2026-09-02, and
                            the default here is now 8192. This
                            comment used to argue that DuckDB's 122,880 default
                            "destroys row-group pruning entirely (ca/2022: 6
                            groups -> 1)". True, and irrelevant: with the bbox a
                            DOUBLE[] there is no row-group pruning to destroy
                            (see docs/bbox-pruning-in-the-naip-index.md), so
                            small groups buy nothing and cost one S3 round trip
                            each. Targeting TWO row groups per partition is
                            21-24% faster cold from Lambda -- and two beats one,
                            which is worse than both (a single chunk must be
                            fetched whole before decode starts). Prefer
                            row_group_size ~= ceil(rows/2), which a single
                            partitioned COPY cannot express -- hence 8192 as the
                            best constant, and rewrite_index_layout.py for the
                            per-partition optimum. 2048 only earns its keep if
                            the bbox ever becomes a struct, and that change
                            measured slower on the common path.

  ORDER BY ST_Hilbert(...)  With EXPLICIT per-region bounds. This is a NO-OP on
                            current data and is kept as insurance: rebuilding
                            with no ORDER BY at all gives identical locality
                            (15.4% mean row-group box either way) because the
                            lake already arrives spatially clustered. The bounds
                            are the load-bearing part -- unbounded ST_Hilbert
                            collapses locality to 99.2%, indistinguishable from
                            ORDER BY random() at 98.9%.

zstd instead of DuckDB's default snappy is worth ~26% (measured 23.3-29.7% over
seven partitions); the JSON columns compress ~8-14x, geometry barely at all.

SCHEMA: this deliberately does NOT follow the stac-geoparquet spec
(github.com/radiantearth/stac-geoparquet-spec), which wants `properties`
flattened to top-level columns, `assets` as a struct, `bbox` as a STRUCT rather
than a DOUBLE[], `datetime` as a native timestamp, a `links` column, and no
`type`. That version was built and measured; it was not worth shipping.

What it bought, on the full 295,232-row collection: 43.8 -> 29.7 MB (-32%), and
real row-group pruning. As a DOUBLE[] the `bbox` statistics sit on ONE leaf
mixing all four dimensions -- on nj/2023 the min was a longitude and the max a
latitude -- so the column prunes nothing; as a STRUCT each dimension gets its
own leaf. Measured from a Lambda in us-west-2, that pruning is worth -41 to -47%
on queries matching nothing.

What it cost: +6-7% on queries that DO match, which is the common case. bbox
filtering alone was break-even in-region, so the residual is most likely footer
parsing -- the flattened schema carries ~15 columns against 8, and the whole
footer is read on every open regardless of projection.

The deciding argument was who benefits, and it was argued from a false premise.
The bbox encoding is a documented pain point for the tiler in threejs-cf-zxy-s1m
(tiler/src/tiler/resolver.py: "this lake declares no GeoParquet `covering`, and
its `bbox` is STAC's plain DOUBLE[]"). That tiler reads
`collection=naip-visualization`, which this writer does not produce -- and the
reasoning stopped there, concluding the pruning win would reach none of this
collection's consumers.

CORRECTED 2026-09-02. "Does not produce" is true; "and cannot" was not. The
premise was that the two source buckets do not match (nj and fl have 2010/ under
naip-analytic and not under naip-visualization) so that collection "has to be
built from its own bucket listing" -- which is right, and is a thing this repo
already does. The ad-hoc descriptor path ingests that bucket by name
(descriptors.py: REQUESTER_PAYS_BUCKETS, and register_adhoc_descriptor's own
error message recommends it), and a lake built that way exists, carrying
ingest_duckdb.py's exact 15-column output schema. What was missing was never the
capability; it was wiring THIS projection to that lake instead of only to
collection=naip.

So the pruning win is reachable by the tiler. It is also not a win. Re-measured
2026-09-02 from a Lambda in us-west-2 on the ISOLATED bbox change -- struct bbox
only, 9 columns, everything else identical, five cold containers per cell -- the
regression above survives without the column flattening it was blamed on:

    tile   array (published)   struct
    hit          242.9 ms     285.6 ms   +17.6%
    miss         208.3 ms     111.2 ms   -46.6%

The miss lands inside the -41 to -47% band recorded above; the hit is WORSE than
the +6-7%, not better. Bytes fetched do drop on a hit (-41%), which is why the
byte-level harness pointed the other way. Request counts explain the gap: the
struct's four bbox leaves are four column chunks where the array had one, so
pruning five of six row groups still costs TWO EXTRA ROUND TRIPS (11 requests ->
13). In-region, round trips dominate transfer at this file size. On a miss the
statistics prune before any of that (10 -> 4 requests) and the win is real.

So the rejection stands, on firmer ground than when it was written: not footer
parsing, but request count on the common path. The workload is mostly hits --
NAIP covers CONUS, so a tile matching nothing is an edge case.

Revisit only if the query mix shifts toward misses. The better lever for this
index is orthogonal: `assets` + `properties` are 25.7% of the file and the tiler
needs only href out of them, which is what the promoted asset_href/gsd columns
above already address -- fewer bytes with no extra column chunks. Unmeasured.
"""

import argparse
import os
from time import perf_counter

import duckdb
import duckdb_s3

# The lake collection to project, and the index collection it publishes as. The
# index names collections after the source BUCKET (naip-analytic), while the lake
# names them after the dataset (naip).
SOURCE_COLLECTION = os.environ.get("S3_COG_STAC_INDEX_SOURCE_COLLECTION", "naip")
TARGET_COLLECTION = os.environ.get("S3_COG_STAC_INDEX_TARGET_COLLECTION", "naip-analytic")

DEFAULT_LAKE = os.environ.get("S3_COG_LAKE_ROOT", "/cache/exports/naip_rgbir_duckdb")
DEFAULT_OUT = os.environ.get("S3_COG_STAC_INDEX", "s3://naip-geoparquet-index/manifest-index")

# 8192, not 2048: measured 2026-09-02, see the row_group_size note above and
# docs/bbox-pruning-in-the-naip-index.md. Small groups cost one S3 round trip
# each and buy no pruning, because the DOUBLE[] bbox statistics are
# dimension-mixed and prune nothing.
#
# 8192 is the smallest single value that keeps EVERY partition in this
# collection at one or two row groups (78 at one, 4 at two, against 2048's
# spread up to eight). It is a compromise: the per-partition optimum is
# ceil(rows/2), and a single COPY with partition_by writes every partition with
# one row_group_size, so the writer cannot express that. Running
# rewrite_index_layout.py afterwards lands each partition on its own optimum;
# this default just makes the un-rewritten output good rather than bad.
#
# DuckDB clamps this to a multiple of its 2048 vector size and folds a trailing
# group smaller than that into the previous one, which is why the counts above
# are not plain ceil(rows/8192).
DEFAULT_ROW_GROUP_SIZE = 8192

# Constant STAC scaffolding, matching what the published index already carries.
STAC_VERSION = "1.0.0"
# KNOWN INCONSISTENCY, left alone deliberately: projection extension v2.0.0
# replaced the numeric `proj:epsg` with the string `proj:code`, and this repo's
# own /search already emits proj:code (app/viewer/app.js). The index stays on
# v1.0.0 + proj:epsg because moving it is a breaking change for external readers
# and buys nothing on its own -- it only makes sense bundled with the wider
# spec-compliance pass the module docstring explains was rejected.
PROJECTION_EXTENSION = "https://stac-extensions.github.io/projection/v1.0.0/schema.json"
COG_MEDIA_TYPE = "image/tiff; application=geotiff; profile=cloud-optimized"


def parse_args():
    parser = argparse.ArgumentParser(description="Project the GeoParquet lake into the stac-geoparquet index.")
    parser.add_argument("--lake", default=DEFAULT_LAKE, help="Lake root (local path or s3://)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Index root to write (local path or s3://)")
    parser.add_argument("--source-collection", default=SOURCE_COLLECTION)
    parser.add_argument("--target-collection", default=TARGET_COLLECTION)
    parser.add_argument("--regions", nargs="*", help="Limit to these regions (default: all in the lake)")
    parser.add_argument("--years", nargs="*", type=int, help="Limit to these years (default: all)")
    parser.add_argument("--row-group-size", type=int, default=DEFAULT_ROW_GROUP_SIZE)
    return parser.parse_args()


def build_sql(lake_glob: str, target_collection: str) -> str:
    """SELECT projecting lake rows into STAC Items.

    Every field comes from a column the lake already carries; nothing is
    re-derived from the COGs. `properties` keeps the index's existing keys and
    additionally carries the lake's naip:* values (resolution/quad) that the
    published index omits.

    This matches the published index's shape on purpose -- see the module
    docstring for the spec-compliant alternative that was measured and rejected.
    """
    return f"""
      with src as (
        select
          source_bucket, source_key, asset_href, region, year,
          geometry, bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
          acquisition_date, gsd, properties as naip_props,
          proj_epsg, proj_shape, proj_transform
        from read_parquet('{lake_glob}', hive_partitioning=true)
      ),
      -- Per-region extent for ST_Hilbert. Explicit bounds are required: the
      -- default degenerates over a single state and worsens locality.
      region_bounds as (
        select region, ST_Extent(ST_Extent_Agg(geometry)) as ext
        from src group by region
      )
      select
        '{target_collection}/' || src.source_key                        as id,
        'Feature'                                                        as type,
        '{STAC_VERSION}'                                                 as stac_version,
        ['{PROJECTION_EXTENSION}']                                       as stac_extensions,
        src.geometry                                                     as geometry,
        [src.bbox_xmin, src.bbox_ymin, src.bbox_xmax, src.bbox_ymax]     as bbox,
        strftime(src.acquisition_date, '%Y-%m-%dT00:00:00Z')             as datetime,
        json_merge_patch(
          json_object(
            'datetime',       strftime(src.acquisition_date, '%Y-%m-%dT00:00:00Z'),
            'gsd',            src.gsd,
            'region',         src.region,
            'year',           src.year,
            'proj:epsg',      src.proj_epsg,
            'proj:shape',     src.proj_shape,
            'proj:transform', src.proj_transform
          ),
          coalesce(src.naip_props, '{{}}')
        )                                                                as properties,
        json_object(
          'data', json_object(
            'href',  src.asset_href,
            'type',  '{COG_MEDIA_TYPE}',
            'roles', ['data']
          )
        )                                                                as assets,
        -- Promoted out of the JSON blobs: a reader needing only href/gsd can
        -- skip `assets` + `properties` entirely, which are 25.7% of the file.
        src.asset_href                                                   as asset_href,
        src.gsd                                                          as gsd,
        '{target_collection}'                                            as collection,
        src.region                                                       as region,
        src.year                                                         as year
      from src join region_bounds using (region)
      order by src.region, src.year, ST_Hilbert(src.geometry, region_bounds.ext)
    """


def build(lake_root, out_path, source_collection, target_collection, regions, years, row_group_size) -> int:
    lake_glob = f"{lake_root.rstrip('/')}/collection={source_collection}"
    if regions and len(regions) == 1:
        lake_glob += f"/region={regions[0]}"
        if years and len(years) == 1:
            lake_glob += f"/year={years[0]}"
    lake_glob += "/**/*.parquet"

    con = duckdb.connect()
    duckdb_s3.configure(con, lake_glob, out_path, spatial=True)

    sql = build_sql(lake_glob, target_collection)
    filters = []
    if regions:
        filters.append("region in (" + ", ".join(f"'{r}'" for r in regions) + ")")
    if years:
        filters.append("year in (" + ", ".join(str(int(y)) for y in years) + ")")
    if filters:
        sql = f"select * from ({sql}) where {' and '.join(filters)}"

    copy_opts = (
        "format parquet, compression zstd, geoparquet_version 'V2', "
        f"row_group_size {row_group_size}, "
        "partition_by (collection, region, year), overwrite_or_ignore true"
    )
    con.execute(f"copy ({sql}) to '{out_path}' ({copy_opts});")

    written = con.sql(
        f"select count(*) from read_parquet('{out_path}/collection={target_collection}/**/*.parquet',"
        " hive_partitioning=true)"
    ).fetchone()[0]
    con.close()
    return written


def main():
    started = perf_counter()
    args = parse_args()
    print(f"lake  : {args.lake} (collection={args.source_collection})", flush=True)
    print(f"index : {args.out} (collection={args.target_collection})", flush=True)
    count = build(
        args.lake,
        args.out,
        args.source_collection,
        args.target_collection,
        args.regions,
        args.years,
        args.row_group_size,
    )
    print(f"timings total_ms={(perf_counter() - started) * 1000:.1f}", flush=True)
    print(f"done: {count} STAC Items in {args.out}", flush=True)


if __name__ == "__main__":
    main()
