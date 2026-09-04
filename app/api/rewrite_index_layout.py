"""Re-encode published index partitions to two row groups and zstd.

WHY, measured 2026-09-02 (docs/bbox-pruning-in-the-naip-index.md): the published
index reads cost S3 ROUND TRIPS, not bytes. Each row group is a separate ranged
GET per column, and with `bbox` stored as a DOUBLE[] its statistics are
dimension-mixed and prune nothing -- so every group is read on every query and
the extra groups buy nothing at all. Collapsing ca/2022 from 6 groups to 2 is
23.5% faster cold from a Lambda in us-west-2; tx/2022 from 9 to 2 is 21.0%.

TWO, not one. One row group is consistently WORSE than two (ca -22.9% against
-29.3%, tx -28.1% against -32.3%): a single chunk has to be fetched whole before
decode can start, where two overlap. The target is a count, not a size, which is
why this computes row_group_size per partition rather than taking a constant.

WHAT IT DOES NOT CHANGE: the schema. Same nine columns in the same order, same
row order, same partitioning, `bbox` still a DOUBLE[]. Consumers need no change
-- the tiler in threejs-cf-zxy-s1m keeps working unmodified, with no redeploy.
The struct-bbox schema change measured SLOWER on the common path and is not what
this does; see the note.

WHAT IT SKIPS: partitions already at 1-2 row groups. 29 of 79 naip-visualization
partitions are one group already, and la/2023 (2 groups) measured 2.8% SLOWER
re-encoded, so the floor is left alone. The win lives in the 13 partitions at 4+
groups that hold 41% of the rows.

SAFETY. The undo is S3 versioning, enabled on naip-geoparquet-index 2026-09-03
with a lifecycle rule keeping the two newest noncurrent versions. An earlier
version of this script copied every partition to a backup prefix first, because
the bucket had none; that is now the bucket's job rather than this script's.

What it still does is verify BEFORE overwriting: the rewrite is staged to a
separate key, and row count, column list, row order and resulting group count are
checked against the live object. A mismatch leaves the live object untouched and
the staged file behind to inspect. Verification is the part worth keeping --
versioning lets you undo a bad write, but only if you notice it.

To roll one partition back:

    aws s3api list-object-versions --bucket naip-geoparquet-index \
        --prefix manifest-index/collection=<c>/region=<r>/year=<y>/
    aws s3api copy-object --bucket naip-geoparquet-index --key <key> \
        --copy-source '<bucket>/<key>?versionId=<id>' --request-payer requester

Usage:
    python rewrite_index_layout.py                          # dry run, all partitions
    python rewrite_index_layout.py --collection naip-analytic
    python rewrite_index_layout.py --regions tx ca --apply
"""

import argparse
import math
import os
from time import perf_counter

import boto3
import duckdb
import duckdb_s3

DEFAULT_INDEX = os.environ.get("S3_COG_STAC_INDEX", "s3://naip-geoparquet-index/manifest-index")
DEFAULT_COLLECTION = os.environ.get("S3_COG_STAC_INDEX_TARGET_COLLECTION", "naip-visualization")

# Rewrite only partitions with at least this many row groups. Below it there is
# nothing to collapse and re-encoding measured slightly negative.
MIN_GROUPS_TO_REWRITE = 3

# The measured optimum. See the module docstring: one group is worse than two.
# It is a CEILING, not an exact target -- DuckDB folds a trailing group smaller
# than its 2048 vector size into the previous one, so for some row counts two is
# simply unreachable. ut/2021 (6,032 rows) is the worked example: row_group_size
# 2048 gives three groups, and 4096 gives one, because the 1,936-row tail is
# below the vector size. One group still measured -22 to -28%, so landing on one
# is a fine outcome and only "more groups than we started with" is a failure.
TARGET_GROUPS = 2

# DuckDB clamps row_group_size to a multiple of its 2048 vector size, so the
# computed value is rounded up to one -- otherwise the emitted layout silently
# differs from the requested one.
VECTOR_SIZE = 2048


def parse_args():
    parser = argparse.ArgumentParser(description="Re-encode index partitions to two row groups and zstd.")
    parser.add_argument("--index", default=DEFAULT_INDEX, help="Index root (s3:// or local path)")
    parser.add_argument("--collection", default=DEFAULT_COLLECTION)
    parser.add_argument("--regions", nargs="*", help="Limit to these regions (default: all)")
    parser.add_argument("--years", nargs="*", type=int, help="Limit to these years (default: all)")
    parser.add_argument(
        "--staging-prefix",
        default=".rewrite-staging",
        help="Bucket-relative prefix the rewrite is staged under before verification. "
        "Kept OUTSIDE the index prefix so a reader globbing the index tree cannot see it.",
    )
    parser.add_argument("--apply", action="store_true", help="Actually write. Without it, this is a dry run.")
    parser.add_argument("--limit", type=int, help="Stop after this many partitions (for a trial run)")
    return parser.parse_args()


def split_s3(uri: str) -> tuple[str, str]:
    bucket, _, key = uri[len("s3://") :].partition("/")
    return bucket, key


def list_partitions(s3, index_root: str, collection: str, regions, years) -> list[str]:
    """Every data file under one collection, as full s3:// URIs."""
    bucket, prefix = split_s3(index_root)
    prefix = f"{prefix.rstrip('/')}/collection={collection}/"
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix, RequestPayer="requester"):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".parquet"):
                continue
            parts = dict(seg.split("=", 1) for seg in key.split("/") if "=" in seg and len(seg.split("=", 1)) == 2)
            if regions and parts.get("region") not in set(regions):
                continue
            if years and int(parts.get("year", -1)) not in set(years):
                continue
            out.append(f"s3://{bucket}/{key}")
    return sorted(out)


def require_versioning(s3, bucket: str) -> None:
    """Refuse to overwrite a bucket that cannot roll the overwrite back.

    This script used to copy every partition to a backup prefix, which made the
    undo unconditional. It now relies on bucket versioning instead -- so the
    undo is a bucket SETTING, and a setting can be off. Checking it is what
    keeps the safety honest rather than assumed; without this, --apply against
    an unversioned bucket would destroy the previous layout while printing that
    it had been retained.
    """
    status = s3.get_bucket_versioning(Bucket=bucket).get("Status")
    if status != "Enabled":
        raise SystemExit(
            f"refusing to write: s3://{bucket} has versioning {status or 'disabled'}, "
            f"so an overwrite could not be rolled back.\n"
            f"  aws s3api put-bucket-versioning --bucket {bucket} "
            f"--versioning-configuration Status=Enabled"
        )


def row_group_size_for(rows: int) -> int:
    """Smallest vector-size multiple that lands the partition on TARGET_GROUPS."""
    per_group = math.ceil(rows / TARGET_GROUPS)
    return max(VECTOR_SIZE, math.ceil(per_group / VECTOR_SIZE) * VECTOR_SIZE)


def describe(con, path: str) -> dict:
    rows, groups = con.sql(f"select num_rows, num_row_groups from parquet_file_metadata('{path}')").fetchone()
    columns = [r[0] for r in con.sql(f"describe select * from read_parquet('{path}')").fetchall()]
    return {"rows": rows, "groups": groups, "columns": columns}


def order_fingerprint(con, path: str) -> str:
    """Hash of the id column IN FILE ORDER.

    The rewrite must not reorder rows: the partitions arrive spatially clustered
    (analytic inherits it from the lake) and that clustering is the only thing
    making any statistic selective. Comparing this before and after is what
    catches a parallel read that silently reshuffled.
    """
    # threads=1 for the duration: string_agg with no ORDER BY concatenates in
    # scan order, and only a single-threaded scan makes that order the FILE
    # order rather than whatever the parallel readers finished in. read_parquet
    # exposes no rowid to sort by, so serialising the scan is the way to get a
    # positional fingerprint at all.
    threads = con.sql("select current_setting('threads')").fetchone()[0]
    con.execute("SET threads TO 1")
    try:
        return con.sql(f"select md5(string_agg(id, '|')) from read_parquet('{path}')").fetchone()[0]
    finally:
        con.execute(f"SET threads TO {threads}")


def rewrite(con, src: str, dest: str, rows: int) -> int:
    rgs = row_group_size_for(rows)
    # select * preserves the column list and order; preserve_insertion_order (on
    # by default) keeps the row order, which order_fingerprint then verifies.
    con.execute(
        f"copy (select * from read_parquet('{src}')) to '{dest}' "
        f"(format parquet, compression zstd, geoparquet_version 'V2', row_group_size {rgs})"
    )
    return rgs


def main():
    args = parse_args()
    s3 = boto3.client("s3")
    con = duckdb.connect()
    duckdb_s3.configure(con, args.index, spatial=True)

    if args.apply:
        require_versioning(s3, split_s3(args.index)[0])

    partitions = list_partitions(s3, args.index, args.collection, args.regions, args.years)
    if args.limit:
        partitions = partitions[: args.limit]
    print(f"{len(partitions)} partition(s) under collection={args.collection}\n")

    bucket, index_prefix = split_s3(args.index)
    staging_prefix = args.staging_prefix.strip("/")

    header = f"{'partition':38} {'rows':>8} {'groups':>7} {'bytes':>12}  action"
    print(header)
    print("-" * len(header))

    planned, skipped, written, saved = 0, 0, 0, 0
    for src in partitions:
        before = describe(con, src)
        key = split_s3(src)[1]
        label = "/".join(seg.split("=", 1)[1] for seg in key.split("/") if "=" in seg)
        size = s3.head_object(Bucket=bucket, Key=key, RequestPayer="requester")["ContentLength"]

        if before["groups"] < MIN_GROUPS_TO_REWRITE:
            print(
                f"{label:38} {before['rows']:>8,} {before['groups']:>7} {size:>12,}"
                f"  skip (already <{MIN_GROUPS_TO_REWRITE})"
            )
            skipped += 1
            continue

        planned += 1
        rgs = row_group_size_for(before["rows"])
        if not args.apply:
            print(
                f"{label:38} {before['rows']:>8,} {before['groups']:>7} {size:>12,}  "
                f"would rewrite -> {TARGET_GROUPS} groups (row_group_size {rgs:,})"
            )
            continue

        # No backup copy: bucket versioning retains the object being replaced,
        # and the lifecycle rule keeps the two newest noncurrent versions. The
        # module docstring carries the rollback command.
        tmp = f"s3://{bucket}/{staging_prefix}/{key.replace('/', '_')}"
        t0 = perf_counter()
        rewrite(con, src, tmp, before["rows"])
        after = describe(con, tmp)

        # Verify against the ORIGINAL before overwriting it. Any mismatch leaves
        # the live object untouched and the staged file behind for inspection.
        problems = []
        if after["rows"] != before["rows"]:
            problems.append(f"rows {before['rows']} -> {after['rows']}")
        if after["columns"] != before["columns"]:
            problems.append("column list changed")
        if after["groups"] > TARGET_GROUPS:
            problems.append(f"got {after['groups']} groups, wanted at most {TARGET_GROUPS}")
        elif after["groups"] >= before["groups"]:
            problems.append(f"no improvement: {before['groups']} -> {after['groups']} groups")
        if order_fingerprint(con, tmp) != order_fingerprint(con, src):
            problems.append("row order changed")
        if problems:
            print(
                f"{label:38} {before['rows']:>8,} {before['groups']:>7} {size:>12,}  "
                f"FAILED VERIFY: {'; '.join(problems)} (left staged at {tmp}, live file untouched)"
            )
            continue

        s3.copy_object(
            Bucket=bucket,
            Key=key,
            CopySource={"Bucket": bucket, "Key": split_s3(tmp)[1]},
            RequestPayer="requester",
        )
        s3.delete_object(Bucket=bucket, Key=split_s3(tmp)[1], RequestPayer="requester")
        new_size = s3.head_object(Bucket=bucket, Key=key, RequestPayer="requester")["ContentLength"]
        saved += size - new_size
        written += 1
        print(
            f"{label:38} {before['rows']:>8,} {before['groups']:>7} {size:>12,}  "
            f"-> {after['groups']} groups, {new_size:,} bytes "
            f"({100 * (new_size / size - 1):+.1f}%), {perf_counter() - t0:.1f}s"
        )

    print()
    if args.apply:
        print(f"rewrote {written}, skipped {skipped}, {saved:,} bytes saved")
        print(f"replaced objects retained as noncurrent versions in s3://{bucket}/")
    else:
        print(f"dry run: would rewrite {planned}, skip {skipped}. Re-run with --apply to write.")
    con.close()


if __name__ == "__main__":
    main()
