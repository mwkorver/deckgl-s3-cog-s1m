"""Convert the USGS S1M GeoPackage footprint index to queryable Parquet."""

import argparse
import sqlite3
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def _gpkg_geometry_to_wkb(blob: bytes) -> bytes:
    flags = blob[3]
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    envelope_bytes = envelope_sizes[(flags >> 1) & 0x07]
    return bytes(blob[8 + envelope_bytes :])


def convert(source: Path, output: Path) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(source))
    try:
        rows = con.execute(
            """
            SELECT p.fid, p.dataset, p.geom, r.minx, r.maxx, r.miny, r.maxy
            FROM S1M_Products p
            JOIN rtree_S1M_Products_geom r ON r.id = p.fid
            WHERE p.geom IS NOT NULL AND p.dataset IS NOT NULL
            ORDER BY r.minx, r.miny
            """
        ).fetchall()
    finally:
        con.close()

    table = pa.table(
        {
            "fid": pa.array((row[0] for row in rows), type=pa.int64()),
            "dataset": pa.array((row[1] for row in rows), type=pa.string()),
            "geometry_wkb": pa.array((_gpkg_geometry_to_wkb(row[2]) for row in rows), type=pa.binary()),
            "bbox_xmin": pa.array((row[3] for row in rows), type=pa.float64()),
            "bbox_xmax": pa.array((row[4] for row in rows), type=pa.float64()),
            "bbox_ymin": pa.array((row[5] for row in rows), type=pa.float64()),
            "bbox_ymax": pa.array((row[6] for row in rows), type=pa.float64()),
        }
    )
    pq.write_table(
        table,
        output,
        compression="zstd",
        row_group_size=512,
        write_statistics=True,
    )
    return table.num_rows


def main():
    parser = argparse.ArgumentParser(description="Convert S1M_Products.gpkg to the terrain reader's Parquet index.")
    parser.add_argument("source", type=Path, help="Local S1M_Products.gpkg")
    parser.add_argument("output", type=Path, help="Output .parquet path")
    args = parser.parse_args()
    count = convert(args.source, args.output)
    print(f"Wrote {count:,} footprints to {args.output}")


if __name__ == "__main__":
    main()
