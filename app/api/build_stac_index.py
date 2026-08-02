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
                            option, 0/6 without. Those per-row-group extents are
                            what let a reader skip row groups, so dropping them
                            silently removes the index's spatial pruning.

  row_group_size            DuckDB's default is 122,880 rows, which collapses a
                            whole partition into ONE row group and destroys
                            row-group pruning entirely (ca/2022: 6 groups -> 1).
                            The published files sit at ~1,845 rows/group.

  ORDER BY ST_Hilbert(...)  With EXPLICIT per-region bounds. The published index
                            is already spatially clustered (mean row-group box
                            15.4% of the partition extent; shuffled it is 98.6%),
                            so the sort here PRESERVES that rather than adding
                            it. ST_Hilbert without bounds degenerates over a
                            single state's extent and makes locality worse.

zstd instead of DuckDB's default snappy is worth ~26% (measured 23.3-29.7% over
seven partitions); the JSON columns compress ~8-14x, geometry barely at all.
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

# Matches the published files (~1,845 rows/group). See the module docstring.
DEFAULT_ROW_GROUP_SIZE = 1845

# Constant STAC scaffolding, matching what the published index already carries.
STAC_VERSION = "1.0.0"
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
    additionally carries the lake's naip:* values, which the manifest-index
    reader needs (resolution/quad) and which the published index omits.
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
