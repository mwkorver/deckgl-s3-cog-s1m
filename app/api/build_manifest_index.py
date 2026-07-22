"""Build a partitioned Parquet index from the flat NAIP manifest (RGBIR COGs only).

The published manifest (naip-analytic-manifest.txt) is a 404 MB, ~7M-line flat
list of every object key in the bucket -- FGDC sidecars, original imagery, COGs,
and index artifacts all interleaved. Scanning it per ingest job is the slow part
of the pipeline, so this does the scan ONCE and writes a small queryable index.

Filter: only the COG tiles -> keys matching `*/rgbir_cog/*.tif` (the single COG
product NAIP publishes; there is no rgb_cog). Each kept line is parsed into
columns from the key/filename and written to a Hive-partitioned tree:

    manifest_index/state=tx/naip_year=2020/data_0.parquet

A per-job ingest then does a pushdown read of one partition
(`manifest_index/state=tx/naip_year=2020/`) -- a few ms, no 404 MB rescan --
instead of streaming the whole manifest. Re-run only when AWS publishes a new
manifest.

Usage:
    python build_manifest_index.py
    python build_manifest_index.py --manifest /path/to/manifest.txt --out /path/to/index
"""

import argparse
import os
import shutil
from pathlib import Path
from time import perf_counter

import duckdb
import duckdb_s3

# Local cache lives at app/cache, i.e. one level up from this api/
# dir. Derive it from __file__ so the defaults work wherever the repo is cloned
# (no hardcoded home path). Override either via the env vars or --manifest/--out.
_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
DEFAULT_MANIFEST = os.environ.get(
    "S3_COG_MANIFEST_PATH",
    str(_CACHE_DIR / "naip-analytic-manifest.txt"),
)
DEFAULT_OUT = os.environ.get("S3_COG_MANIFEST_INDEX", str(_CACHE_DIR / "manifest_index")).rstrip("/")

# ASCII unit separator: a byte that never appears in an S3 key, so read_csv
# treats each line as a single 'key' column instead of splitting on commas.
_UNIT_SEP = "\x1f"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build a partitioned Parquet index of RGBIR COG keys from the flat NAIP manifest"
    )
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST, help="Flat manifest .txt path (local or s3://)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="Output partitioned Parquet index root")
    parser.add_argument(
        "--row-group-size",
        type=int,
        default=20000,
        help="Parquet row group size within each partition file",
    )
    return parser.parse_args()


def build(manifest: str, out: str, row_group_size: int) -> int:
    # Full rebuild: clear any prior tree so stale partition files can't linger
    # and duplicate keys (DuckDB's overwrite_or_ignore appends rather than
    # clearing). Only applies to local paths; s3:// outputs are managed by the
    # COPY's overwrite semantics.
    if "://" not in out and Path(out).exists():
        shutil.rmtree(out)
    if "://" not in out:
        Path(out).mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    # duckdb_s3 loads httpfs and, when either side is s3://, creates the
    # credential secret and enables requester-pays. Both matter here: the source
    # manifest lives in requester-pays naip-analytic, and --out is normally the
    # published naip-geoparquet-index bucket. Plain `LOAD httpfs` (what this
    # script did originally) 403s against both.
    duckdb_s3.configure(con, manifest, out, spatial=False)

    con.execute(
        f"""
        copy (
          with lines as (
            select key
            from read_csv(
              '{manifest}',
              columns = {{'key': 'VARCHAR'}},
              header = false,
              delim = '{_UNIT_SEP}'
            )
            -- COG tiles only: the rgbir_cog category, .tif extension.
            where key like '%/rgbir_cog/%' and key like '%.tif'
          )
          select
            key                                   as source_key,
            split_part(key, '/', 1)               as state,
            cast(split_part(key, '/', 2) as int)  as naip_year,
            split_part(key, '/', 3)               as resolution,
            split_part(key, '/', 5)               as quad,
            split_part(key, '/', -1)              as filename,
            'rgbir'                               as product,
            try_strptime(
              regexp_extract(split_part(key, '/', -1), '_(\\d{{8}})', 1),
              '%Y%m%d'
            )::date                               as acq_date
          from lines
        ) to '{out}' (
          format parquet,
          row_group_size {row_group_size},
          partition_by (state, naip_year),
          overwrite true
        );
        """
    )

    count = con.sql(f"select count(*) from read_parquet('{out}/**/*.parquet', hive_partitioning=true)").fetchone()[0]
    con.close()
    return count


def main():
    started_at = perf_counter()
    args = parse_args()
    count = build(args.manifest, args.out, args.row_group_size)
    total_ms = (perf_counter() - started_at) * 1000
    print(f"timings total_ms={total_ms:.1f}", flush=True)
    print(f"done: indexed {count} RGBIR COG keys to {args.out}", flush=True)


if __name__ == "__main__":
    main()
