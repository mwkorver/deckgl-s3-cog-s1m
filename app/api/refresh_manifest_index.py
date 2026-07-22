"""Incrementally refresh the NAIP manifest index from the LIVE bucket.

AWS froze s3://naip-analytic/manifest.txt at 2023-03-09, so any NAIP published
since (years >= 2022) is invisible to the manifest-derived index -- which is why
the ingest panel stopped offering new years (e.g. WA 2023). Historical years are
immutable and already in the index, so this does NOT rebuild everything. It:

  1. lists only recent-year prefixes per state from the bucket (cheap),
  2. collects their rgbir_cog/*.tif COG keys,
  3. builds index partitions from those keys (reusing build_manifest_index.py),
  4. merges only those (state, naip_year) partitions into the target index(es),
     leaving the frozen-manifest history untouched.

Run periodically; NAIP publishes a few states per year.

Usage:
  source ../.env && unset AWS_PROFILE
  python refresh_manifest_index.py --years-from 2022 \
      --index ../cache/manifest_index s3://naip-geoparquet-index/manifest-index
  python refresh_manifest_index.py --years-from 2022 --dry-run   # discover only
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import boto3

BUCKET = os.environ.get("S3_COG_SOURCE_BUCKET", "naip-analytic")
HERE = Path(__file__).resolve().parent


def _list_prefixes(s3, prefix):
    """Immediate sub-prefixes (CommonPrefixes) under prefix, e.g. 'wa/' -> 'wa/2023/'."""
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=BUCKET, Prefix=prefix, Delimiter="/", RequestPayer="requester"
    ):
        out += [cp["Prefix"] for cp in page.get("CommonPrefixes", [])]
    return out


def _list_cog_keys(s3, prefix):
    """All rgbir_cog/*.tif keys under prefix (recursive)."""
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix, RequestPayer="requester"):
        for obj in page.get("Contents", []):
            k = obj["Key"]
            if "/rgbir_cog/" in k and k.endswith(".tif"):
                keys.append(k)
    return keys


def discover(s3, years_from, only_states):
    """Return (all_keys, found) where found = [(state, year, n_keys), ...]."""
    states = [p.rstrip("/").split("/")[-1] for p in _list_prefixes(s3, "")]
    if only_states:
        states = [s for s in states if s in set(only_states)]
    all_keys, found = [], []
    for st in sorted(states):
        for yp in _list_prefixes(s3, f"{st}/"):
            yr = yp.rstrip("/").split("/")[-1]
            if not yr.isdigit() or int(yr) < years_from:
                continue
            keys = _list_cog_keys(s3, yp)
            if keys:
                all_keys += keys
                found.append((st, int(yr), len(keys)))
                print(f"  {st} {yr}: {len(keys):,} COGs", flush=True)
    return all_keys, found


def _merge_partition(src_index, dst_index, state, year):
    """Copy one state=/naip_year= partition from src into dst (local or s3://)."""
    rel = f"state={state}/naip_year={year}"
    src = f"{src_index}/{rel}"
    if str(dst_index).startswith("s3://"):
        dst = f"{dst_index.rstrip('/')}/{rel}/"
        subprocess.run(
            ["aws", "s3", "rm", "--recursive", dst], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        subprocess.run(["aws", "s3", "cp", "--recursive", f"{src}/", dst], check=True, stdout=subprocess.DEVNULL)
    else:
        dstp = Path(dst_index) / rel
        if dstp.exists():
            subprocess.run(["rm", "-rf", str(dstp)], check=True)
        dstp.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["cp", "-r", src, str(dstp)], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years-from", type=int, default=2022)
    ap.add_argument("--states", nargs="*", help="limit to these states (default: all)")
    ap.add_argument(
        "--index",
        nargs="+",
        required=False,
        default=[],
        help="one or more manifest index roots to update (local dir or s3://)",
    )
    ap.add_argument("--dry-run", action="store_true", help="discover only; don't write")
    args = ap.parse_args()

    s3 = boto3.client("s3")
    print(f"discovering {BUCKET} partitions with year >= {args.years_from} ...", flush=True)
    all_keys, found = discover(s3, args.years_from, args.states)
    print(f"\nfound {len(found)} (state,year) partition(s), {len(all_keys):,} COG keys total")

    if args.dry_run or not all_keys:
        return
    if not args.index:
        sys.exit("nothing to write: pass --index <root> [<root> ...] (or --dry-run)")

    with tempfile.TemporaryDirectory() as tmp:
        keyfile = Path(tmp) / "keys.txt"
        keyfile.write_text("\n".join(all_keys) + "\n")
        idx_tmp = str(Path(tmp) / "index")
        subprocess.run(
            [sys.executable, str(HERE / "build_manifest_index.py"), "--manifest", str(keyfile), "--out", idx_tmp],
            check=True,
        )
        for dst in args.index:
            print(f"\nmerging {len(found)} partition(s) into {dst}", flush=True)
            for state, year, _ in found:
                _merge_partition(idx_tmp, dst, state, year)
                print(f"  merged {state} {year}", flush=True)
    print("done.", flush=True)


if __name__ == "__main__":
    main()
