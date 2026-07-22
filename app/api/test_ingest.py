import io
import os
import sys
from unittest.mock import patch

import pyarrow as pa
import pytest

# Ensure the parent directory is in the path so we can import ingest_duckdb
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ingest_duckdb as ingest


def test_derive_product():
    """Verify reduction of product_family names to display/filter tokens."""
    assert ingest.derive_product("rgbir_cog") == "rgbir"
    assert ingest.derive_product("rgb_cogs") == "rgb"
    assert ingest.derive_product("other_product") == "other_product"
    assert ingest.derive_product(None) is None
    assert ingest.derive_product("") is None


def test_reconcile_completeness_ok():
    """Verify that matching manifest and payload counts logs successfully."""
    manifest = {"key1": {"state": "nj", "naip_year": "2020"}, "key2": {"state": "nj", "naip_year": "2020"}}
    payloads = [{"state": "nj", "naip_year": "2020"}, {"state": "nj", "naip_year": "2020"}]
    with patch("sys.stdout", new=io.StringIO()) as fake_out:
        ingest.reconcile_completeness(manifest, payloads, strict=True)
        output = fake_out.getvalue()
        assert "every partition ingested 100% of its manifest tiles" in output


def test_reconcile_completeness_shortfall_warning():
    """Verify that a shortfall warning is logged when strict=False."""
    manifest = {"key1": {"state": "nj", "naip_year": "2020"}, "key2": {"state": "nj", "naip_year": "2020"}}
    payloads = [{"state": "nj", "naip_year": "2020"}]
    with patch("sys.stdout", new=io.StringIO()) as fake_out:
        ingest.reconcile_completeness(manifest, payloads, strict=False)
        output = fake_out.getvalue()
        assert "COMPLETENESS WARNING" in output
        assert "Proceeding anyway" in output


def test_reconcile_completeness_shortfall_strict():
    """Verify that a shortfall aborts execution when strict=True."""
    manifest = {"key1": {"state": "nj", "naip_year": "2020"}, "key2": {"state": "nj", "naip_year": "2020"}}
    payloads = [{"state": "nj", "naip_year": "2020"}]
    with pytest.raises(SystemExit, match="aborting before write"):
        ingest.reconcile_completeness(manifest, payloads, strict=True)


def test_payloads_to_arrow_naip():
    """Verify mapping of NAIP-style metadata properties to Arrow columnar fields."""
    payloads = [
        {
            "state": "nj",
            "naip_year": 2020,
            "product_family": "rgbir_cog",
            "resolution_dir": "6IN",
            "spatial_prefix": "n013e300",
            "source_bucket": "naip-analytic",
            "source_key": "nj/2020/rgbir_cog/n013e300.tif",
            "asset_href": "s3://naip-analytic/nj/2020/rgbir_cog/n013e300.tif",
            "geom_geojson": "POLYGON ((...))",
            "bbox_xmin": -75.0,
            "bbox_ymin": 39.0,
            "bbox_xmax": -74.0,
            "bbox_ymax": 40.0,
            "acquisition_date": "2020-07-15",
            "gsd": 0.6,
            "proj_epsg": 3857,
            "proj_shape": [1000, 1000],
            "proj_transform": [1.0, 0.0, 0.0, 0.0, -1.0, 0.0],
        }
    ]

    table = ingest.payloads_to_arrow(payloads, collection="naip")
    assert isinstance(table, pa.Table)
    assert "region" in table.column_names
    assert "year" in table.column_names
    assert table.column("region").to_pylist() == ["nj"]
    assert table.column("year").to_pylist() == [2020]

    props = table.column("properties").to_pylist()
    assert len(props) == 1
    assert "naip:product" in props[0]
    assert "naip:resolution" in props[0]


def test_payloads_to_arrow_generic():
    """Verify handling of pre-mapped generic collection payloads in Arrow converter."""
    payloads = [
        {
            "region": "ky",
            "year": 2022,
            "properties": {"season": 2, "resolution": "3IN"},
            "source_bucket": "kyfromabove",
            "source_key": "ky/2022/image.tif",
            "asset_href": "s3://kyfromabove/ky/2022/image.tif",
            "geom_geojson": "POLYGON ((...))",
            "bbox_xmin": -84.0,
            "bbox_ymin": 37.0,
            "bbox_xmax": -83.0,
            "bbox_ymax": 38.0,
            "acquisition_date": "2022-09-01",
            "gsd": 0.1,
            "proj_epsg": 3089,
            "proj_shape": [2000, 2000],
            "proj_transform": [1.0, 0.0, 0.0, 0.0, -1.0, 0.0],
        }
    ]

    table = ingest.payloads_to_arrow(payloads, collection="kyfromabove")
    assert table.column("region").to_pylist() == ["ky"]
    assert table.column("year").to_pylist() == [2022]

    props = table.column("properties").to_pylist()
    assert "resolution" in props[0]
    assert "season" in props[0]


if __name__ == "__main__":
    tests = [
        test_derive_product,
        test_reconcile_completeness_ok,
        test_reconcile_completeness_shortfall_warning,
        test_reconcile_completeness_shortfall_strict,
        test_payloads_to_arrow_naip,
        test_payloads_to_arrow_generic,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
            import traceback

            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
