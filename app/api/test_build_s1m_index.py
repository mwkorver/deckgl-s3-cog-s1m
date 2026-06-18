import os
import sqlite3
import sys

import pyarrow.parquet as pq

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_s1m_index import convert


def _gpkg_blob(wkb: bytes) -> bytes:
    return b"GP\x00\x01" + (6350).to_bytes(4, "little") + wkb


def test_convert_writes_reader_columns(tmp_path):
    source = tmp_path / "S1M_Products.gpkg"
    output = tmp_path / "S1M_Products.parquet"
    con = sqlite3.connect(source)
    try:
        con.execute(
            "CREATE TABLE S1M_Products "
            "(fid INTEGER PRIMARY KEY, dataset TEXT, geom BLOB)"
        )
        con.execute(
            "CREATE TABLE rtree_S1M_Products_geom "
            "(id INTEGER PRIMARY KEY, minx REAL, maxx REAL, miny REAL, maxy REAL)"
        )
        geometry_wkb = b"\x01test-wkb"
        con.execute(
            "INSERT INTO S1M_Products VALUES (?, ?, ?)",
            (7, "S1M/test.tif", _gpkg_blob(geometry_wkb)),
        )
        con.execute(
            "INSERT INTO rtree_S1M_Products_geom VALUES (?, ?, ?, ?, ?)",
            (7, 1.0, 3.0, 2.0, 4.0),
        )
        con.commit()
    finally:
        con.close()

    assert convert(source, output) == 1
    table = pq.read_table(output)
    assert table.column_names == [
        "fid",
        "dataset",
        "geometry_wkb",
        "bbox_xmin",
        "bbox_xmax",
        "bbox_ymin",
        "bbox_ymax",
    ]
    assert table["dataset"].to_pylist() == ["S1M/test.tif"]
    assert table["geometry_wkb"].to_pylist() == [geometry_wkb]
