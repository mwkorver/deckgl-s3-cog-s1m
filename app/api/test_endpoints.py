import os
import sys

# Override the S3 lake path to be local/empty for tests to prevent S3 credential validation
os.environ["S3_COG_LAKE_ROOT"] = ""

import datetime
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

# Ensure the parent directory is in the path so we can import app
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import app

client = TestClient(app)


def test_health():
    """Verify that /health executes successfully against in-memory DuckDB."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_collections():
    """Verify that /collections returns the registered collections."""
    with patch("app.lake_collections") as mock_collections:
        mock_collections.return_value = ["naip", "kyfromabove"]
        response = client.get("/collections")
        assert response.status_code == 200
        data = response.json()
        assert "collections" in data
        ids = [c["id"] for c in data["collections"]]
        assert "naip" in ids
        assert "kyfromabove" in ids


def test_collection_by_id():
    """Verify that retrieving a single collection by ID works."""
    with patch("app.lake_collections") as mock_collections:
        mock_collections.return_value = ["naip", "kyfromabove"]
        response = client.get("/collections/naip")
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "naip"
        assert "links" in data

        response = client.get("/collections/non-existent-collection")
        assert response.status_code == 404


def test_ingest_write_endpoints_require_token_when_configured():
    """Public write endpoints must reject unauthenticated ingest requests."""
    with patch("app.INGEST_TOKEN", "test-ingest-token"):
        response = client.post("/ingest/run", json={"state": "nj", "year": 2020})
        assert response.status_code == 401

        response = client.post("/ingest/run-sync", json={"state": "nj", "year": 2020})
        assert response.status_code == 401


def test_ingest_write_endpoints_accept_bearer_or_ingest_token_header():
    """A valid token should let request validation proceed past auth."""
    with patch("app.INGEST_TOKEN", "test-ingest-token"), patch("app.INGEST_MODE", "sync"):
        response = client.post(
            "/ingest/run",
            headers={"x-ingest-token": "test-ingest-token"},
            json={},
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "state is required"

        response = client.post(
            "/ingest/run-sync",
            headers={"authorization": "Bearer test-ingest-token"},
            json={},
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "state is required"


def test_availability():
    """Verify that /availability queries and returns states/years from DuckDB."""
    with patch("app.get_lake_duckdb") as mock_get_duckdb:
        mock_con = MagicMock()
        mock_cursor = MagicMock()
        mock_con.cursor.return_value = mock_cursor
        mock_get_duckdb.return_value = mock_con

        mock_cursor.execute.return_value.fetchall.return_value = [
            ("nj", 2020, 1.0, -75.6, 38.9, -73.9, 41.4),
            ("nj", 2022, 0.3, -75.6, 38.9, -73.9, 41.4),
            ("ky", 2021, 0.6, -89.6, 36.5, -81.9, 39.2),
        ]

        response = client.get("/availability?collection=naip")
        assert response.status_code == 200
        data = response.json()
        assert data["engine"] == "duckdb"
        assert data["states"] == {"ky": [2021], "nj": [2022, 2020]}
        assert data["gsd"] == {"ky": {"2021": 0.6}, "nj": {"2020": 1.0, "2022": 0.3}}
        assert data["extent"]["ky"]["2021"] == [-89.6, 36.5, -81.9, 39.2]
        assert data["extent"]["nj"]["2022"] == [-75.6, 38.9, -73.9, 41.4]


def test_sign():
    """Verify that /sign signs a registered collection source."""
    href = "s3://naip-analytic/ri/2021/60cm/rgbir_cog/41071/item.tif"
    with patch("app.maybe_sign_s3_href") as mock_maybe_sign:
        mock_maybe_sign.return_value = ("https://signed-url.example.com/item.tif", {}, 600)

        response = client.get("/sign", params={"href": href})
        assert response.status_code == 200
        data = response.json()
        assert data["href"] == href
        assert data["signed"] == "https://signed-url.example.com/item.tif"
        assert data["expires_in"] == 600


def test_sign_rejects_private_and_unknown_buckets():
    """The public signer must not expose role-readable or arbitrary buckets."""
    private_href = "s3://deckgl-s3-cog-s1m-000000000000-us-west2/lake/item.parquet"
    response = client.get(f"/sign?href={private_href}")
    assert response.status_code == 403

    response = client.get("/sign?href=s3://unregistered-bucket/item.tif")
    assert response.status_code == 403

    response = client.get("/sign?href=s3://naip-analytic/manifest.txt")
    assert response.status_code == 403


def test_sign_rejects_malformed_s3_urls():
    response = client.get("/sign", params={"href": "s3://naip-analytic"})
    assert response.status_code == 400

    response = client.get(
        "/sign",
        params={"href": "s3://naip-analytic/item.tif?versionId=123"},
    )
    assert response.status_code == 400


def test_s3_proxy_is_not_exposed():
    """The public read API must not proxy arbitrary role-readable S3 objects."""
    response = client.get("/proxy/private-bucket/lake/item.parquet")
    assert response.status_code == 404


def test_search_validation():
    """Verify search input validation fails on missing or invalid bbox."""
    response = client.post("/search", json={"collections": ["naip"]})
    assert response.status_code == 400
    assert "bbox is required" in response.json()["detail"]

    response = client.post("/search", json={"collections": ["naip"], "bbox": "not-a-list"})
    assert response.status_code == 400


def test_search_success():
    """Verify search executes and maps DuckDB rows to a STAC FeatureCollection."""
    with patch("app.get_lake_duckdb") as mock_get_duckdb:
        mock_con = MagicMock()
        mock_cursor = MagicMock()
        mock_con.cursor.return_value = mock_cursor
        mock_get_duckdb.return_value = mock_con

        dummy_geom = '{"type":"Polygon","coordinates":[[[-75,39],[-74,39],[-74,40],[-75,40],[-75,39]]]}'
        mock_cursor.execute.return_value.fetchall.return_value = [
            (
                "naip-analytic",
                "state/year/tile.tif",
                dummy_geom,
                -75.0,
                39.0,
                -74.0,
                40.0,
                datetime.date(2022, 6, 15),
                0.6,
                "naip",
                "nj",
                2022,
                "{}",
                3857,
                "[10, 10]",
                "[1, 0, 0, 0, 1, 0]",
                "s3://naip-analytic/state/year/tile.tif",
            )
        ]

        search_payload = {"collections": ["naip"], "bbox": [-75.0, 39.0, -74.0, 40.0], "limit": 10}
        response = client.post("/search", json=search_payload)
        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "FeatureCollection"
        assert len(data["features"]) == 1
        feat = data["features"][0]
        assert feat["id"] == "naip-analytic/state/year/tile.tif"
        assert feat["collection"] == "naip"
        assert feat["assets"]["image"]["href"] == "s3://naip-analytic/state/year/tile.tif"

        # Structural STAC guarantees. These mirror what the published schemas
        # enforce (checked out-of-band against schemas.stacspec.org and
        # stac-extensions.github.io) without making the suite hit the network.
        assert feat["stac_version"] == "1.1.0"
        # projection v2.0 uses the string proj:code, and its schema rejects any
        # other proj:-namespaced field -- so proj:epsg must NOT come back.
        assert feat["properties"]["proj:code"] == "EPSG:3857"
        assert "proj:epsg" not in feat["properties"]
        # Namespaced fields require their extension to be declared.
        assert "https://stac-extensions.github.io/projection/v2.0.0/schema.json" in feat["stac_extensions"]
        # An Item carrying `collection` must have a rel="collection" link.
        assert any(link["rel"] == "collection" for link in feat["links"])


def test_make_stac_feature_datetime_fallbacks():
    """`datetime` is required on every Item, so a row with no acquisition date
    must fall back to the flight year as a bounded interval rather than drop the
    field. See make_stac_feature()."""
    import json as _json

    from app import make_stac_feature

    geom = _json.dumps({"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]})

    def row(acq_date, year, proj_epsg=None, properties=None):
        return (
            "b",
            "k",
            geom,
            0.0,
            0.0,
            1.0,
            1.0,
            acq_date,
            None,
            "naip",
            "nj",
            year,
            properties,
            proj_epsg,
            None,
            None,
            "s3://b/k",
        )

    dated = make_stac_feature(row(datetime.date(2022, 8, 3), 2022))
    assert dated["properties"]["datetime"] == "2022-08-03T00:00:00Z"
    assert "start_datetime" not in dated["properties"]

    undated = make_stac_feature(row(None, 2022))
    assert undated["properties"]["datetime"] is None
    assert undated["properties"]["start_datetime"] == "2022-01-01T00:00:00Z"
    assert undated["properties"]["end_datetime"] == "2022-12-31T23:59:59Z"

    # Extensions are declared only when their fields are actually emitted.
    assert undated["stac_extensions"] == []
    projected = make_stac_feature(row(None, 2022, proj_epsg=3857))
    assert projected["stac_extensions"] == ["https://stac-extensions.github.io/projection/v2.0.0/schema.json"]
    gridded = make_stac_feature(row(None, 2022, properties=_json.dumps({"naip:quad": "40074"})))
    assert gridded["properties"]["grid:code"] == "DOQQ-40074"
    assert "https://stac-extensions.github.io/grid/v1.1.0/schema.json" in gridded["stac_extensions"]
