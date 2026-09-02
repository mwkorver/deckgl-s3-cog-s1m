"""Measure what actually prunes row groups in the published NAIP index.

Written to settle docs/bbox-pruning-in-the-naip-index.md, which observes -- correctly
-- that the index's `bbox: DOUBLE[]` produces one repeated leaf whose min/max mixes
longitudes with latitudes, and concludes from that that nothing prunes. Those are two
different claims. The published files also carry per-row-group GeospatialStatistics on
the geometry column (`geo_bbox`), which is a per-dimension spatial statistic that a
reader CAN prune on, so "the bbox column prunes nothing" does not imply "no row group
is skipped".

Phase 0 (`--phase 0`, `facts`)  Footer facts for a published partition: row-group
    layout, whether the bbox leaf is dimension-mixed, whether geo_bbox is present, and
    the mean row-group extent as a fraction of the file's own extent (locality -- with
    no locality, per-dimension statistics prune nothing because every group overlaps
    every query).

Phase 1 (`--phase 1`, `matrix`)  The 2x2 that isolates the mechanism. Rewrite one
    partition four ways -- {bbox DOUBLE[], bbox STRUCT} x {geoparquet_version V2 (writes
    geo_bbox), V1 (does not)} -- keeping row order and row_group_size fixed so the only
    variables are the two under test. Comparing the struct row against the array row
    answers what a schema change adds ON TOP of the pruning geo_bbox already delivers,
    which is the comparison the doc's framing skips.

Bytes, not seconds. The consumer runs in Lambda against S3, where the cost is bytes
fetched, and a local warm-cache timing says nothing about that. Each variant is served
over a loopback HTTP server that records every Range header DuckDB sends, so the
measurement is the actual byte ranges requested, mapped back to the row groups they
land in. Deterministic, no AWS, no charges.

Usage:
    python bench_bbox_pruning.py facts                    # phase 0, downloads ca/2022
    python bench_bbox_pruning.py matrix                   # phase 0 + 1
    python bench_bbox_pruning.py matrix --source ./x.parquet --workdir /tmp/bench
"""

import argparse
import json
import os
import re
import shutil
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import duckdb
import duckdb_s3

DEFAULT_SOURCE = os.environ.get(
    "S3_COG_BENCH_SOURCE",
    "s3://naip-geoparquet-index/manifest-index/collection=naip-analytic/region=ca/year=2022/data_0.parquet",
)
DEFAULT_WORKDIR = Path(__file__).resolve().parent.parent / "cache" / "bench-bbox"

# The published layout, pinned: DuckDB clamps row_group_size to a multiple of its 2048
# vector size, so this is the floor and what the published index actually carries.
ROW_GROUP_SIZE = 2048

# Roughly a z15 tile in degrees. Index reads happen at z14-18, where the query envelope
# is small enough to be an effective point lookup -- measuring with a state-sized
# envelope would make every variant look identical.
TILE_DEG = 0.011

# The nine STAC columns the published index carries, bbox handled separately per variant.
_PASSTHROUGH = "id, type, stac_version, stac_extensions, geometry, datetime, properties, assets"


def connect(*, httpfs: bool = False):
    con = duckdb.connect()
    duckdb_s3.load_extensions(con, spatial=True, httpfs=httpfs)
    return con


def fetch(uri: str, dest: Path) -> None:
    """Download the published object verbatim.

    Not via `COPY ... TO`: rewriting it through DuckDB would replace the very footer
    phase 0 exists to inspect. requester-pays because the index bucket charges
    non-owner readers, matching how duckdb_s3 configures the read path.
    """
    import boto3

    bucket, _, key = uri[len("s3://") :].partition("/")
    boto3.client("s3").download_file(bucket, key, str(dest), ExtraArgs={"RequestPayer": "requester"})


# --------------------------------------------------------------------------- phase 0


@dataclass
class Facts:
    path: str
    size_bytes: int
    rows: int
    row_groups: list[int]
    bbox_leaves: dict[str, tuple[float, float]]
    geo_stats_groups: int
    locality_pct: float | None
    group_boxes: list[dict]

    @property
    def bbox_mixed(self) -> bool:
        """True when one leaf's min/max spans both longitude and latitude.

        The DOUBLE[] tell: a min near -75 (a longitude) against a max near 41 (a
        latitude), from which nothing about overlap can be concluded.
        """
        return len(self.bbox_leaves) == 1 and any(lo < -90 < hi for lo, hi in self.bbox_leaves.values())


def footer_facts(con, path: str) -> Facts:
    rows, _ = con.sql(f"select num_rows, num_row_groups from parquet_file_metadata('{path}')").fetchone()
    group_rows = [
        r[1]
        for r in con.sql(
            f"select distinct row_group_id, row_group_num_rows from parquet_metadata('{path}') order by row_group_id"
        ).fetchall()
    ]
    leaves = {
        name.split(", ")[-1]: (float(lo), float(hi))
        for name, lo, hi in con.sql(
            f"""select path_in_schema, min(stats_min::double), max(stats_max::double)
                from parquet_metadata('{path}') where path_in_schema like 'bbox%' group by 1"""
        ).fetchall()
    }
    geo = con.sql(
        f"""select geo_bbox from parquet_metadata('{path}')
            where path_in_schema = 'geometry' order by row_group_id"""
    ).fetchall()
    boxes = [g[0] for g in geo if g[0] is not None]
    locality = None
    if boxes:
        xmin = min(b["xmin"] for b in boxes)
        xmax = max(b["xmax"] for b in boxes)
        ymin = min(b["ymin"] for b in boxes)
        ymax = max(b["ymax"] for b in boxes)
        total = (xmax - xmin) * (ymax - ymin)
        mean = sum((b["xmax"] - b["xmin"]) * (b["ymax"] - b["ymin"]) for b in boxes) / len(boxes)
        locality = 100 * mean / total if total else None
    return Facts(
        path=path,
        size_bytes=os.path.getsize(path) if os.path.exists(path) else -1,
        rows=rows,
        row_groups=group_rows,
        bbox_leaves=leaves,
        geo_stats_groups=len(boxes),
        locality_pct=locality,
        group_boxes=boxes,
    )


def print_facts(f: Facts) -> None:
    print(f"\n{f.path}")
    print(f"  {f.rows:,} rows in {len(f.row_groups)} row groups {f.row_groups}, {f.size_bytes:,} bytes")
    for name, (lo, hi) in sorted(f.bbox_leaves.items()):
        print(f"  bbox leaf {name:<5} min {lo:>12.4f}  max {hi:>12.4f}")
    if f.bbox_mixed:
        print("  -> ONE leaf, min is a longitude and max is a latitude: prunes nothing")
    elif len(f.bbox_leaves) == 4:
        print("  -> four leaves, one per dimension: usable for pruning")
    print(f"  geo_bbox on {f.geo_stats_groups}/{len(f.row_groups)} row groups", end="")
    print(f", mean row-group extent {f.locality_pct:.1f}% of file extent" if f.locality_pct else "")


# --------------------------------------------------------------------------- phase 1


def write_variants(con, src: str, workdir: Path) -> dict[str, Path]:
    """The 2x2: {array, struct} bbox x {V2, V1} geoparquet version.

    Row order is inherited from the source (already Hilbert-clustered per region by
    build_stac_index.py) and row_group_size is fixed, so bbox shape and geo_bbox are
    the only variables. V1 is not a proposal -- it is the control that shows what
    geo_bbox alone is worth.
    """
    projections = {
        "array": f"select {_PASSTHROUGH}, bbox from read_parquet('{src}')",
        "struct": (
            f"select {_PASSTHROUGH},"
            " {'xmin': bbox[1], 'ymin': bbox[2], 'xmax': bbox[3], 'ymax': bbox[4]} as bbox"
            f" from read_parquet('{src}')"
        ),
    }
    out = {}
    for shape, sql in projections.items():
        for version in ("V2", "V1"):
            name = f"{shape}-{version.lower()}"
            path = workdir / f"{name}.parquet"
            con.execute(
                f"copy ({sql}) to '{path}' (format parquet, compression zstd,"
                f" geoparquet_version '{version}', row_group_size {ROW_GROUP_SIZE})"
            )
            out[name] = path

    # Fifth, outside the 2x2 because it cannot be held to the same controls: adding
    # `covering` means a pyarrow rewrite, and that DROPS the geo_bbox statistics
    # (verified: 6/6 groups before, 0/6 after). So this measures covering WITHOUT the
    # geometry statistics rather than in addition to them -- which is itself a finding:
    # the easy way to declare covering costs you the statistic that does the pruning.
    covering = workdir / "struct-covering.parquet"
    shutil.copy(out["struct-v2"], covering)
    add_covering(covering)
    out["struct-covering"] = covering
    return out


def add_covering(path: Path) -> None:
    """Declare GeoParquet `covering` pointing at the struct bbox columns.

    DuckDB does not emit it even when the struct is named `bbox` (verified: the `geo`
    key it writes carries version/primary_column/columns and nothing else), so a reader
    that would use the covering cannot find it. Patched in after the write because it is
    file metadata, not data -- and because whether readers act on it is one of the
    things worth measuring separately from the schema change itself.
    """
    import pyarrow.parquet as pq

    fmeta = pq.read_metadata(path)
    meta = {k.decode(): v.decode() for k, v in (fmeta.metadata or {}).items()}
    geo = json.loads(meta.get("geo", "{}"))
    column = geo.get("primary_column", "geometry")
    geo.setdefault("columns", {}).setdefault(column, {})["covering"] = {
        "bbox": {
            "xmin": ["bbox", "xmin"],
            "ymin": ["bbox", "ymin"],
            "xmax": ["bbox", "xmax"],
            "ymax": ["bbox", "ymax"],
        }
    }
    meta["geo"] = json.dumps(geo)
    table = pq.read_table(path)
    tmp = path.with_suffix(".covering.parquet")
    pq.write_table(
        table.replace_schema_metadata(meta),
        tmp,
        compression="zstd",
        row_group_size=ROW_GROUP_SIZE,
    )
    shutil.move(tmp, path)


def row_group_extents(con, path: str) -> list[tuple[int, int]]:
    """Byte range of each row group, for mapping fetched ranges back to groups."""
    rows = con.sql(
        f"""select row_group_id,
                   min(coalesce(dictionary_page_offset, data_page_offset)),
                   max(data_page_offset + total_compressed_size)
            from parquet_metadata('{path}') group by 1 order by 1"""
    ).fetchall()
    return [(int(lo), int(hi)) for _, lo, hi in rows]


class _RangeLogHandler(BaseHTTPRequestHandler):
    """A range-honouring static server that records every byte range requested.

    Written out rather than subclassing SimpleHTTPRequestHandler, which ignores `Range`
    and answers 200 with the whole body -- against which DuckDB reads the entire file
    and every variant measures identical. Answering 206 correctly is what makes the
    byte counts mean anything.
    """

    ranges: list[tuple[int, int]] = []
    directory = "."

    def _file(self) -> Path:
        return Path(self.directory) / os.path.basename(self.path.split("?")[0])

    def do_HEAD(self):  # noqa: N802 - stdlib naming
        self._respond(head_only=True)

    def do_GET(self):  # noqa: N802 - stdlib naming
        self._respond(head_only=False)

    def _respond(self, *, head_only: bool):
        path = self._file()
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        m = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range", "") or "")
        if m:
            lo = int(m.group(1))
            hi = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        else:
            lo, hi = 0, size - 1
        if not head_only:
            type(self).ranges.append((lo, hi))

        self.send_response(206 if m else 200)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(hi - lo + 1))
        self.send_header("Content-Type", "application/octet-stream")
        if m:
            self.send_header("Content-Range", f"bytes {lo}-{hi}/{size}")
        self.end_headers()
        if head_only:
            return
        with path.open("rb") as fh:
            fh.seek(lo)
            self.wfile.write(fh.read(hi - lo + 1))

    def log_message(self, *args):
        pass


def serve(directory: Path):
    handler = type("H", (_RangeLogHandler,), {"ranges": []})
    handler.directory = str(directory)
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, handler


def tiles(con, src: str) -> dict[str, tuple[float, float, float, float]]:
    """A hit tile and a miss tile, both derived from the data rather than hardcoded.

    The miss is the interesting one: inside the file's own bounding box but covering no
    quad. That is where per-dimension statistics can skip every group, and where the
    earlier measurement recorded in build_stac_index.py saw -41 to -47%.
    """
    x, y = con.sql(
        f"select (bbox[1] + bbox[3]) / 2, (bbox[2] + bbox[4]) / 2 from read_parquet('{src}') limit 1"
    ).fetchone()
    hit = (x - TILE_DEG / 2, y - TILE_DEG / 2, x + TILE_DEG / 2, y + TILE_DEG / 2)

    xmin, ymin, xmax, ymax = con.sql(
        f"""select min(bbox[1]), min(bbox[2]), max(bbox[3]), max(bbox[4])
            from read_parquet('{src}')"""
    ).fetchone()
    miss = None
    for i in range(1, 40):
        cx = xmin + (xmax - xmin) * (i / 40)
        for j in range(1, 40):
            cy = ymin + (ymax - ymin) * (j / 40)
            box = (cx - TILE_DEG / 2, cy - TILE_DEG / 2, cx + TILE_DEG / 2, cy + TILE_DEG / 2)
            n = con.sql(
                f"""select count(*) from read_parquet('{src}')
                    where ST_Intersects(geometry, ST_MakeEnvelope({box[0]},{box[1]},{box[2]},{box[3]}))"""
            ).fetchone()[0]
            if n == 0:
                miss = box
                break
        if miss:
            break
    return {"hit": hit, "miss-in-extent": miss}


def predicates(shape: str, box) -> dict[str, str]:
    w, s, e, n = box
    envelope = f"ST_Intersects(geometry, ST_MakeEnvelope({w}, {s}, {e}, {n}))"
    if shape == "array":
        bbox = f"bbox[1] <= {e} and bbox[3] >= {w} and bbox[2] <= {n} and bbox[4] >= {s}"
    else:
        bbox = f"bbox.xmin <= {e} and bbox.xmax >= {w} and bbox.ymin <= {n} and bbox.ymax >= {s}"
    return {"geometry only": envelope, "bbox only": bbox, "bbox + geometry": f"{bbox} and {envelope}"}


def measure(url: str, where: str, extents, handler, *, prefetch: bool = True) -> tuple[int, int, int]:
    """Run one query over HTTP; return (rows, bytes fetched, row groups touched).

    `prefetch` is DuckDB's Parquet prefetcher, ON by default and therefore what the
    Lambda consumer actually experiences. It coalesces reads aggressively enough that a
    partition this size comes down whole, which no schema change can undo -- so the
    matrix is run both ways: prefetch on for the production number, off to isolate
    whether the statistics prune at all.
    """
    handler.ranges = []
    con = connect(httpfs=True)
    con.execute("set enable_http_metadata_cache=false; set enable_external_file_cache=false")
    con.execute(f"set disable_parquet_prefetching={str(not prefetch).lower()}")
    rows = con.sql(f"select count(*) from read_parquet('{url}') where {where}").fetchone()[0]
    con.close()
    fetched = sum(hi - lo + 1 for lo, hi in handler.ranges)
    touched = sum(1 for lo, hi in extents if any(rlo <= hi and rhi >= lo for rlo, rhi in handler.ranges))
    return rows, fetched, unique_bytes(handler.ranges), touched


def unique_bytes(ranges) -> int:
    """Distinct bytes covered, merging overlaps.

    With prefetching off DuckDB re-reads the same ranges and the raw total runs to
    several times the file size; that number measures read amplification, not transfer.
    Both are reported -- S3 bills the raw total, but only the distinct figure says how
    much of the file the query actually needed.
    """
    merged, total = [], 0
    for lo, hi in sorted(ranges):
        if merged and lo <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    for lo, hi in merged:
        total += hi - lo + 1
    return total


def run_matrix(con, src: str, variants: dict[str, Path], workdir: Path) -> None:
    boxes = tiles(con, src)
    httpd, handler = serve(workdir)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        for prefetch in (True, False):
            mode = "prefetch ON (production default)" if prefetch else "prefetch OFF (isolates pruning)"
            print(f"\n{'-' * 78}\n{mode}\n{'-' * 78}")
            for label, box in boxes.items():
                if box is None:
                    print(f"\n[{label}] no such tile found in this partition, skipped")
                    continue
                print(f"\n[{label}] envelope {tuple(round(v, 4) for v in box)}")
                print(f"  {'variant':<16} {'predicate':<16} {'rows':>5} {'bytes':>10} {'distinct':>10} {'groups':>8}")
                for name, path in variants.items():
                    extents = row_group_extents(con, str(path))
                    shape = "array" if name.startswith("array") else "struct"
                    for pred_name, where in predicates(shape, box).items():
                        rows, fetched, distinct, touched = measure(
                            f"{base}/{path.name}", where, extents, handler, prefetch=prefetch
                        )
                        print(
                            f"  {name:<16} {pred_name:<16} {rows:>5} {fetched:>10,}"
                            f" {distinct:>10,} {touched:>5}/{len(extents)}"
                        )
    finally:
        httpd.shutdown()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("phase", choices=("facts", "matrix"), help="facts = phase 0, matrix = 0 + 1")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Published partition to measure")
    parser.add_argument("--workdir", default=str(DEFAULT_WORKDIR), type=Path)
    return parser.parse_args()


def main():
    args = parse_args()
    args.workdir.mkdir(parents=True, exist_ok=True)
    local = args.workdir / "source.parquet"

    con = connect(httpfs=False)
    if args.source.startswith("s3://"):
        if not local.exists():
            fetch(args.source, local)
            print(f"cached {args.source} -> {local}")
    else:
        local = Path(args.source)

    print("=" * 78)
    print("PHASE 0  footer facts")
    print("=" * 78)
    print_facts(footer_facts(con, str(local)))

    if args.phase == "matrix":
        print("\n" + "=" * 78)
        print("PHASE 1  bbox shape x geo statistics, bytes fetched over HTTP range reads")
        print("=" * 78)
        variants = write_variants(con, str(local), args.workdir)
        for path in variants.values():
            print_facts(footer_facts(con, str(path)))
        run_matrix(con, str(local), variants, args.workdir)
    con.close()


if __name__ == "__main__":
    main()
