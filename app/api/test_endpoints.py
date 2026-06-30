import os
import sys

# Override S3 lake paths to be local/empty for tests to prevent S3 credential validation
os.environ["S3_COG_LAKE_ROOT"] = ""
os.environ["S3_COG_EMBED_LAKE_ROOT"] = ""

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
        assert data["states"] == {
            "ky": [2021],
            "nj": [2022, 2020]
        }
        assert data["gsd"] == {
            "ky": {"2021": 0.6},
            "nj": {"2020": 1.0, "2022": 0.3}
        }
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


def test_sign_accepts_naip_visualization_source():
    """The RGB NAIP requester-pays bucket is a first-class signable source."""
    href = "s3://naip-visualization/ny/2022/60cm/rgb/40073/item.tif"
    with patch("app.maybe_sign_s3_href") as mock_maybe_sign:
        mock_maybe_sign.return_value = ("https://signed-url.example.com/item.tif", {}, 600)

        response = client.get("/sign", params={"href": href})
        assert response.status_code == 200
        assert response.json()["href"] == href


def test_sign_rejects_private_and_unknown_buckets():
    """The public signer must not expose role-readable or arbitrary buckets."""
    private_href = "s3://deckgl-s3-cog-s1m-495811053987-us-west2/lake/item.parquet"
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


def test_detect_requires_configured_runner():
    """Detection should fail before COG access when the SAM runner is not configured."""
    with patch("app.SAM3_PYTHON", ""), patch("app.SAM3_SCRIPT", ""):
        response = client.post(
            "/detect",
            json={
                "bbox": [-75.0, 39.0, -74.0, 40.0],
                "concept": "swimming pool",
            },
        )
    assert response.status_code == 503
    assert "SAM3_PYTHON and SAM3_SCRIPT" in response.json()["detail"]


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
                "naip-analytic", "state/year/tile.tif", dummy_geom,
                -75.0, 39.0, -74.0, 40.0,
                datetime.date(2022, 6, 15), 0.6, "naip", "nj", 2022, "{}",
                3857, "[10, 10]", "[1, 0, 0, 0, 1, 0]",
                "s3://naip-analytic/state/year/tile.tif"
            )
        ]

        search_payload = {
            "collections": ["naip"],
            "bbox": [-75.0, 39.0, -74.0, 40.0],
            "limit": 10
        }
        response = client.post("/search", json=search_payload)
        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "FeatureCollection"
        assert len(data["features"]) == 1
        feat = data["features"][0]
        assert feat["id"] == "naip-analytic/state/year/tile.tif"
        assert feat["collection"] == "naip"
        assert feat["properties"]["proj:epsg"] == 3857
        assert feat["assets"]["image"]["href"] == "s3://naip-analytic/state/year/tile.tif"


def test_similar_validation():
    """Verify /similar input validation on missing point and bad k/year."""
    response = client.post("/similar", json={})
    assert response.status_code == 400
    assert "lon and lat" in response.json()["detail"]

    response = client.post("/similar", json={"lon": -71.4, "lat": "not-a-number"})
    assert response.status_code == 400

    response = client.post("/similar", json={"lon": -71.4, "lat": 41.8, "year": "soon"})
    assert response.status_code == 400
    assert "year" in response.json()["detail"]


def test_similar_success():
    """Verify /similar resolves the query chip, ranks rows, and maps them to features."""
    with patch("app.get_lake_duckdb") as mock_get_duckdb:
        mock_con = MagicMock()
        mock_cursor = MagicMock()
        mock_con.cursor.return_value = mock_cursor
        mock_get_duckdb.return_value = mock_con

        chip_row = (
            "m_4107113_ne_19_060_20210826", "41071",
            -71.4133, 41.8229, -71.4114, 41.8243,
            datetime.date(2021, 8, 26), 0.6, "ri", 2021,
        )
        dummy_geom = '{"type":"Polygon","coordinates":[[[-71.41,41.82],[-71.40,41.82],[-71.40,41.83],[-71.41,41.83],[-71.41,41.82]]]}'
        knn_rows = [
            (
                "m_4107113_ne_19_060_20210826", "41071", dummy_geom,
                -71.4114, 41.8229, -71.4095, 41.8243,
                datetime.date(2021, 8, 26), 0.6,
                "s3://naip-analytic/ri/2021/60cm/rgbir_cog/41071/m_4107113_ne_19_060_20210826.tif",
                "ri", 2021, 0.9881,
            )
        ]
        mock_cursor.execute.return_value.fetchone.return_value = chip_row
        mock_cursor.execute.return_value.fetchall.return_value = knn_rows

        response = client.post(
            "/similar",
            json={"lon": -71.412, "lat": 41.824, "region": "ri", "year": 2021, "k": 10},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["type"] == "FeatureCollection"
        assert data["query"]["chip"]["naip_item"] == "m_4107113_ne_19_060_20210826"
        assert data["query"]["chip"]["region"] == "ri"
        assert len(data["features"]) == 1
        feat = data["features"][0]
        assert feat["properties"]["sim"] == 0.9881
        assert feat["properties"]["block"] == "41071"
        assert feat["assets"]["source_image"]["href"].startswith("s3://naip-analytic/")


def test_similar_no_chip_at_point():
    """A point no chip covers returns 404, not an empty collection."""
    with patch("app.get_lake_duckdb") as mock_get_duckdb:
        mock_con = MagicMock()
        mock_cursor = MagicMock()
        mock_con.cursor.return_value = mock_cursor
        mock_get_duckdb.return_value = mock_con
        mock_cursor.execute.return_value.fetchone.return_value = None

        response = client.post("/similar", json={"lon": -70.0, "lat": 40.5, "region": "ri"})
        assert response.status_code == 404
        assert "no embedding chip" in response.json()["detail"]


if __name__ == "__main__":
    tests = [
        test_health,
        test_collections,
        test_collection_by_id,
        test_availability,
        test_sign,
        test_sign_rejects_private_and_unknown_buckets,
        test_sign_rejects_malformed_s3_urls,
        test_s3_proxy_is_not_exposed,
        test_search_validation,
        test_search_success,
        test_similar_validation,
        test_similar_success,
        test_similar_no_chip_at_point
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
