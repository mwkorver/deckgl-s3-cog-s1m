import os
import sys
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from s1m_app import app

client = TestClient(app)
TOKEN_HEADER = {"x-demo-token": "test-token"}


def setup_module():
    os.environ["S1M_DEMO_TOKEN"] = "test-token"


def test_health():
    response = client.get("/health", headers=TOKEN_HEADER)
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_missing_token_is_rejected():
    response = client.get("/health")
    assert response.status_code == 401


def test_terrain_uses_cached_index_and_clamps_grid_size():
    payload = {
        "width": 512,
        "height": 512,
        "step": [1.0, 1.0],
        "center_lnglat": [-74.5, 40.0],
        "nodata": -999999.0,
        "z_range": [0.0, 10.0],
        "epsg": 6350,
        "elev_b64": "",
    }
    with (
        patch("s1m_app.s1m.cover_dataset", return_value="s3://prd-tnm/tile.tif"),
        patch("s1m_app.s1m.read_terrain", return_value=payload) as read,
    ):
        response = client.post(
            "/s1m/terrain",
            headers=TOKEN_HEADER,
            json={"lon": -74.5, "lat": 40, "size": 999},
        )

    assert response.status_code == 200
    assert response.json()["dataset"] == "s3://prd-tnm/tile.tif"
    read.assert_called_once_with("s3://prd-tnm/tile.tif", size=512)


def test_terrain_returns_404_without_coverage():
    with patch("s1m_app.s1m.cover_dataset", return_value=None):
        response = client.post(
            "/s1m/terrain",
            headers=TOKEN_HEADER,
            json={"lon": -105, "lat": 39},
        )
    assert response.status_code == 404
